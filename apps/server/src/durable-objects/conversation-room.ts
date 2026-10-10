import { DurableObject } from 'cloudflare:workers';
import {
  MAX_GROUP_MEMBERS,
  type ApiErrorCode,
  type Envelope,
  type Message,
  type OutgoingEnvelope,
  type ServerEvent,
  type SystemEvent,
} from '@koode/shared';
import { coverage, keyedDevices } from '../keys/devices';
import { auditStatement } from '../lib/audit';
import { attachmentKeys } from '../media/storage';
import { loadMessage, loadRow, notifyUsers, toMessage, type MessageRow } from '../messaging/rows';
import { pushMessage } from '../push/dispatch';

export type RoomResult<T> =
  { ok: true; value: T } | { ok: false; code: ApiErrorCode; message: string; details?: unknown };

const fail = (code: ApiErrorCode, message: string, details?: unknown) => ({
  ok: false as const,
  code,
  message,
  ...(details !== undefined && { details }),
});

/** D1 allows 100 bound parameters per statement: 5 per envelope row. */
const ENVELOPES_PER_INSERT = 20;

type Role = 'member' | 'admin';

/**
 * One instance per conversation: the single writer for its message sequence
 * and revisions (so ordering is strict without cross-request locking), the
 * place where membership changes happen, and the fan-out point for messages,
 * receipts and typing. Durable data lives in D1.
 */
export class ConversationRoom extends DurableObject<Env> {
  private conversationId: string | null = null;
  private loading: Promise<boolean> | null = null;
  private lastSeq = 0;
  private lastRev = 0;
  private members = new Map<string, Role>();
  private info: { kind: 'direct' | 'group'; title: string | null } = {
    kind: 'direct',
    title: null,
  };

  /** Load counters and membership once per activation. */
  private load(conversationId: string): Promise<boolean> {
    if (this.loading && this.conversationId === conversationId) return this.loading;
    this.conversationId = conversationId;
    this.loading = (async () => {
      const db = this.env.DB;
      const conv = await db
        .prepare('SELECT last_seq, last_rev, kind, title FROM conversations WHERE id = ?')
        .bind(conversationId)
        .first<{
          last_seq: number;
          last_rev: number;
          kind: 'direct' | 'group';
          title: string | null;
        }>();
      if (!conv) return false;
      const { results } = await db
        .prepare('SELECT user_id, role FROM conversation_members WHERE conversation_id = ?')
        .bind(conversationId)
        .all<{ user_id: string; role: Role }>();
      this.lastSeq = Math.max(this.lastSeq, conv.last_seq);
      this.lastRev = Math.max(this.lastRev, conv.last_rev);
      this.members = new Map(results.map((r) => [r.user_id, r.role]));
      this.info = { kind: conv.kind, title: conv.title };
      return true;
    })().catch((e) => {
      this.loading = null;
      throw e;
    });
    return this.loading;
  }

  private async member(conversationId: string, userId: string): Promise<boolean> {
    return (await this.load(conversationId)) && this.members.has(userId);
  }

  private broadcast(userIds: Iterable<string>, event: ServerEvent) {
    this.ctx.waitUntil(notifyUsers(this.env, userIds, event));
  }

  /** Synchronous: concurrent requests in this instance never share a number. */
  private nextRev() {
    return ++this.lastRev;
  }

  private bumpConversation(seq: number | null, rev: number, now: number) {
    return seq === null
      ? this.env.DB.prepare(
          'UPDATE conversations SET last_rev = MAX(last_rev, ?) WHERE id = ?',
        ).bind(rev, this.conversationId)
      : this.env.DB.prepare(
          `UPDATE conversations SET last_seq = MAX(last_seq, ?1), last_message_seq = MAX(last_message_seq, ?1),
             last_rev = MAX(last_rev, ?2), last_message_at = ?3 WHERE id = ?4`,
        ).bind(seq, rev, now, this.conversationId);
  }

  // ——— Messages ———

  /**
   * Send a message to every member, as ciphertext per device. Members (in
   * realtime) each get their own devices' envelopes.
   */
  private async publish(row: MessageRow) {
    const db = this.env.DB;
    const byUser = new Map<string, Envelope[]>();
    if (row.encryption === 'signal' && row.deleted_at === null) {
      const { results } = await db
        .prepare('SELECT user_id, device, type, body FROM message_envelopes WHERE message_id = ?')
        .bind(row.id)
        .all<{ user_id: string; device: number; type: 2 | 3; body: string }>();
      for (const e of results) {
        const list = byUser.get(e.user_id) ?? [];
        list.push({ deviceId: e.device, type: e.type, body: e.body });
        byUser.set(e.user_id, list);
      }
    }
    await Promise.allSettled(
      [...this.members.keys()].map((u) =>
        notifyUsers(this.env, [u], {
          type: 'message',
          message: toMessage(row, byUser.get(u) ?? []),
        } satisfies ServerEvent),
      ),
    );
  }

  async post(input: {
    conversationId: string;
    senderId: string;
    /** devices.id and Signal number of the sending device. */
    senderDeviceId: string;
    senderDevice: number;
    id: string;
    kind: 'text' | 'attachment' | 'reaction';
    envelopes: OutgoingEnvelope[];
    attachmentId?: string | null;
    targetId?: string | null;
  }): Promise<RoomResult<Message>> {
    if (!(await this.member(input.conversationId, input.senderId))) {
      return fail('not_found', 'Conversation not found');
    }
    const db = this.env.DB;
    const sender = { userId: input.senderId, device: input.senderDevice };

    // Idempotent retries: the client's message id is the key.
    const existing = await db
      .prepare('SELECT conversation_id, sender_id FROM messages WHERE id = ?')
      .bind(input.id)
      .first<{ conversation_id: string; sender_id: string }>();
    if (existing) {
      if (
        existing.conversation_id !== input.conversationId ||
        existing.sender_id !== input.senderId
      )
        return fail('conflict', 'Message id already used');
      return { ok: true, value: (await loadMessage(db, input.conversationId, input.id, sender))! };
    }
    if (input.targetId) {
      const target = await db
        .prepare('SELECT kind, deleted_at FROM messages WHERE id = ? AND conversation_id = ?')
        .bind(input.targetId, input.conversationId)
        .first<{ kind: Message['kind']; deleted_at: number | null }>();
      if (!target) return fail('bad_request', 'Message not found');
      if (target.deleted_at !== null || target.kind === 'system' || target.kind === 'reaction')
        return fail('bad_request', 'This message can’t be reacted to');
    }
    if (input.attachmentId) {
      // Only my own encrypted upload, to this conversation, finished and not sent before.
      const a = await db
        .prepare(
          'SELECT kind, uploaded_at, message_id FROM attachments WHERE id = ? AND conversation_id = ? AND uploader_id = ?',
        )
        .bind(input.attachmentId, input.conversationId, input.senderId)
        .first<{ kind: string; uploaded_at: number | null; message_id: string | null }>();
      if (!a || a.kind !== 'encrypted') return fail('bad_request', 'Attachment not found');
      if (a.uploaded_at === null)
        return fail('bad_request', 'Attachment hasn’t finished uploading');
      if (a.message_id !== null) return fail('conflict', 'Attachment was already sent');
    }

    // Exactly one envelope per current device of every member, except this one.
    const expected = (await keyedDevices(db, [...this.members.keys()])).filter(
      (d) => !(d.userId === input.senderId && d.deviceId === input.senderDevice),
    );
    // Everyone else must be able to read it: a message encrypted for nobody is lost.
    const unkeyed = [...this.members.keys()].filter(
      (u) => u !== input.senderId && !expected.some((d) => d.userId === u),
    );
    if (unkeyed.length)
      return fail('conflict', 'Someone here can’t receive encrypted messages yet', {
        missing: [],
        extra: [],
        unkeyed,
      });
    const mismatch = coverage(expected, input.envelopes);
    if (mismatch) return fail('conflict', 'The recipients’ devices have changed', mismatch);

    const seq = ++this.lastSeq;
    const rev = this.nextRev();
    const now = Date.now();
    const envelopeInserts: D1PreparedStatement[] = [];
    for (let i = 0; i < input.envelopes.length; i += ENVELOPES_PER_INSERT) {
      const chunk = input.envelopes.slice(i, i + ENVELOPES_PER_INSERT);
      envelopeInserts.push(
        db
          .prepare(
            `INSERT INTO message_envelopes (message_id, user_id, device, type, body) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
          )
          .bind(...chunk.flatMap((e) => [input.id, e.userId, e.deviceId, e.type, e.body])),
      );
    }
    try {
      const results = await db.batch([
        input.attachmentId
          ? db
              .prepare('UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL')
              .bind(input.id, input.attachmentId)
          : db.prepare('SELECT 1'),
        db
          .prepare(
            `INSERT INTO messages (id, conversation_id, seq, rev, sender_id, sender_device_id, sender_device, kind, encryption, body, attachment_id, target_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'signal', '', ?, ?, ?)`,
          )
          .bind(
            input.id,
            input.conversationId,
            seq,
            rev,
            input.senderId,
            input.senderDeviceId,
            input.senderDevice,
            input.kind,
            input.attachmentId ?? null,
            input.targetId ?? null,
            now,
          ),
        ...envelopeInserts,
        // Reactions don't count as conversation activity.
        input.kind === 'reaction'
          ? this.env.DB.prepare(
              'UPDATE conversations SET last_seq = MAX(last_seq, ?), last_rev = MAX(last_rev, ?) WHERE id = ?',
            ).bind(seq, rev, this.conversationId)
          : this.bumpConversation(seq, rev, now),
        // The sender has obviously seen their own message.
        db
          .prepare(
            `UPDATE conversation_members SET last_delivered_seq = MAX(last_delivered_seq, ?1),
               last_read_seq = MAX(last_read_seq, ?1), shared_read_seq = MAX(shared_read_seq, ?1)
             WHERE conversation_id = ?2 AND user_id = ?3`,
          )
          .bind(seq, input.conversationId, input.senderId),
      ]);
      if (input.attachmentId && results[0]!.meta.changes !== 1) {
        // Lost a race with another send of the same attachment: undo this one.
        await db.prepare('DELETE FROM messages WHERE id = ?').bind(input.id).run();
        return fail('conflict', 'Attachment was already sent');
      }
    } catch (e) {
      // Lost a race with a duplicate send of the same id: return the stored copy.
      const dup = await loadMessage(db, input.conversationId, input.id, sender);
      if (dup && dup.senderId === input.senderId) return { ok: true, value: dup };
      throw e;
    }

    const row = (await loadRow(db, input.conversationId, input.id))!;
    this.ctx.waitUntil(this.publish(row));
    const message = toMessage(row);
    if (input.kind !== 'reaction') {
      const recipients = [...this.members.keys()].filter((u) => u !== input.senderId);
      this.ctx.waitUntil(
        pushMessage(this.env, message, this.info, recipients).catch((e: unknown) =>
          console.error(JSON.stringify({ type: 'push_error', message: String(e) })),
        ),
      );
    }
    return { ok: true, value: message };
  }

  /**
   * Delete for everyone: the sender, or a group admin. Ciphertexts, the file
   * and reactions to it are erased; the message stays as a "deleted" marker.
   */
  async remove(input: {
    conversationId: string;
    userId: string;
    deviceId: string;
    messageId: string;
  }): Promise<RoomResult<Message>> {
    if (!(await this.member(input.conversationId, input.userId)))
      return fail('not_found', 'Conversation not found');
    const db = this.env.DB;
    const row = await loadRow(db, input.conversationId, input.messageId);
    if (!row) return fail('not_found', 'Message not found');
    if (row.kind === 'system' || row.kind === 'reaction')
      return fail('bad_request', 'This message can’t be deleted');
    const isAdmin = this.info.kind === 'group' && this.members.get(input.userId) === 'admin';
    if (row.sender_id !== input.userId && !isAdmin)
      return fail('forbidden', 'You can only delete your own messages');
    if (row.deleted_at !== null) return { ok: true, value: toMessage(row) };

    const rev = this.nextRev();
    const now = Date.now();
    const reactions = `SELECT id FROM messages WHERE target_id = ?1 AND kind = 'reaction'`;
    await db.batch([
      db
        .prepare(
          "UPDATE messages SET deleted_at = ?, body = '', reply_to_id = NULL, attachment_id = NULL, rev = ? WHERE id = ?",
        )
        .bind(now, rev, input.messageId),
      db
        .prepare(
          `DELETE FROM message_envelopes WHERE message_id = ?1 OR message_id IN (${reactions})`,
        )
        .bind(input.messageId),
      db
        .prepare(
          `UPDATE messages SET deleted_at = ?2, rev = ?3 WHERE id IN (${reactions}) AND deleted_at IS NULL`,
        )
        .bind(input.messageId, now, rev),
      db.prepare('DELETE FROM attachments WHERE message_id = ?').bind(input.messageId),
      this.bumpConversation(null, rev, 0),
      // Moderation is logged (who, which conversation); never the content.
      ...(row.sender_id !== input.userId
        ? [
            auditStatement(
              db,
              'message_deleted',
              { userId: input.userId, deviceId: input.deviceId },
              { conversationId: input.conversationId, senderId: row.sender_id },
            ),
          ]
        : []),
    ]);
    if (row.attachment_id) {
      this.ctx.waitUntil(
        this.env.MEDIA.delete(attachmentKeys(input.conversationId, row.attachment_id)),
      );
    }
    const deleted = (await loadRow(db, input.conversationId, input.messageId))!;
    this.ctx.waitUntil(this.publish(deleted));
    return { ok: true, value: toMessage(deleted) };
  }

  // ——— Receipts and typing ———

  async receipt(input: {
    conversationId: string;
    userId: string;
    delivered?: number;
    read?: number;
    shareRead: boolean;
  }): Promise<RoomResult<{ deliveredSeq: number; readSeq: number }>> {
    if (!(await this.member(input.conversationId, input.userId))) {
      return fail('not_found', 'Conversation not found');
    }
    // Can't acknowledge messages that don't exist yet.
    const read = Math.min(input.read ?? 0, this.lastSeq);
    const delivered = Math.min(Math.max(input.delivered ?? 0, read), this.lastSeq);
    const row = await this.env.DB.prepare(
      `UPDATE conversation_members SET
         last_delivered_seq = MAX(last_delivered_seq, ?1),
         last_read_seq = MAX(last_read_seq, ?2),
         shared_read_seq = CASE WHEN ?3 THEN MAX(shared_read_seq, ?2) ELSE shared_read_seq END
       WHERE conversation_id = ?4 AND user_id = ?5
       RETURNING last_delivered_seq, last_read_seq, shared_read_seq`,
    )
      .bind(delivered, read, input.shareRead ? 1 : 0, input.conversationId, input.userId)
      .first<{ last_delivered_seq: number; last_read_seq: number; shared_read_seq: number }>();
    if (!row) return fail('not_found', 'Conversation not found');

    const base = {
      type: 'receipt' as const,
      conversationId: input.conversationId,
      userId: input.userId,
      deliveredSeq: row.last_delivered_seq,
    };
    const others = [...this.members.keys()].filter((m) => m !== input.userId);
    this.broadcast(others, { ...base, readSeq: row.shared_read_seq });
    this.broadcast([input.userId], { ...base, readSeq: row.last_read_seq }); // my other devices
    return {
      ok: true,
      value: { deliveredSeq: row.last_delivered_seq, readSeq: row.last_read_seq },
    };
  }

  async typing(input: { conversationId: string; userId: string }): Promise<RoomResult<null>> {
    if (!(await this.member(input.conversationId, input.userId))) {
      return fail('not_found', 'Conversation not found');
    }
    const others = [...this.members.keys()].filter((m) => m !== input.userId);
    this.broadcast(others, {
      type: 'typing',
      conversationId: input.conversationId,
      userId: input.userId,
    });
    return { ok: true, value: null };
  }

  // ——— Group administration ———

  /**
   * Appends a system message ("Maya added Dan") with the given membership
   * statements, in one transaction. Everyone affected (including people who
   * just left) is told to refresh the conversation.
   */
  private async systemChange(
    event: SystemEvent,
    statements: D1PreparedStatement[],
    notifyAlso: string[] = [],
  ): Promise<Message> {
    const db = this.env.DB;
    const id = crypto.randomUUID();
    const seq = ++this.lastSeq;
    const rev = this.nextRev();
    const now = Date.now();
    await db.batch([
      ...statements,
      // Group changes are security-relevant (who can read new messages).
      auditStatement(
        db,
        'group_changed',
        { userId: event.actorId },
        {
          conversationId: this.conversationId!,
          action: event.action,
          targets: event.targetIds.length,
        },
      ),
      db
        .prepare(
          `INSERT INTO messages (id, conversation_id, seq, rev, sender_id, kind, body, system, created_at)
           VALUES (?, ?, ?, ?, ?, 'system', '', ?, ?)`,
        )
        .bind(id, this.conversationId, seq, rev, event.actorId, JSON.stringify(event), now),
      this.bumpConversation(seq, rev, now),
    ]);
    const row = (await loadRow(db, this.conversationId!, id))!;
    const message = toMessage(row);
    const everyone = [...new Set([...this.members.keys(), ...notifyAlso])];
    this.broadcast(this.members.keys(), { type: 'message', message });
    this.broadcast(everyone, { type: 'conversation', conversationId: this.conversationId! });
    return message;
  }

  private async groupAdmin(conversationId: string, userId: string): Promise<RoomResult<null>> {
    if (!(await this.member(conversationId, userId)))
      return fail('not_found', 'Conversation not found');
    if (this.info.kind !== 'group') return fail('bad_request', 'Only groups can be changed');
    if (this.members.get(userId) !== 'admin')
      return fail('forbidden', 'Only group admins can do that');
    return { ok: true, value: null };
  }

  /** Called right after a group is created (by the route). */
  async created(input: { conversationId: string; userId: string }): Promise<RoomResult<Message>> {
    if (!(await this.member(input.conversationId, input.userId)))
      return fail('not_found', 'Conversation not found');
    const others = [...this.members.keys()].filter((u) => u !== input.userId);
    const message = await this.systemChange(
      { action: 'created', actorId: input.userId, targetIds: others, title: this.info.title },
      [],
    );
    return { ok: true, value: message };
  }

  async rename(input: {
    conversationId: string;
    userId: string;
    title: string;
  }): Promise<RoomResult<Message>> {
    const allowed = await this.groupAdmin(input.conversationId, input.userId);
    if (!allowed.ok) return allowed;
    const message = await this.systemChange(
      { action: 'renamed', actorId: input.userId, targetIds: [], title: input.title },
      [
        this.env.DB.prepare('UPDATE conversations SET title = ? WHERE id = ?').bind(
          input.title,
          input.conversationId,
        ),
      ],
    );
    this.info = { ...this.info, title: input.title };
    return { ok: true, value: message };
  }

  /** `userIds` must already be checked as active accounts (route). */
  async addMembers(input: {
    conversationId: string;
    userId: string;
    userIds: string[];
  }): Promise<RoomResult<Message | null>> {
    const allowed = await this.groupAdmin(input.conversationId, input.userId);
    if (!allowed.ok) return allowed;
    const added = [...new Set(input.userIds)].filter((u) => !this.members.has(u));
    if (added.length === 0) return { ok: true, value: null };
    if (this.members.size + added.length > MAX_GROUP_MEMBERS)
      return fail('bad_request', `Groups can have up to ${MAX_GROUP_MEMBERS} people`);
    const now = Date.now();
    // New members see history from here on (their read position starts at the end).
    const statements = added.map((u) =>
      this.env.DB.prepare(
        `INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_delivered_seq, last_read_seq, shared_read_seq)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(input.conversationId, u, now, this.lastSeq, this.lastSeq, this.lastSeq),
    );
    added.forEach((u) => this.members.set(u, 'member'));
    const message = await this.systemChange(
      { action: 'added', actorId: input.userId, targetIds: added, title: null },
      statements,
    );
    return { ok: true, value: message };
  }

  /**
   * Account deletion: every message this person sent here is deleted for
   * everyone (ciphertext and files erased) under one new revision, and they
   * leave (groups record it; a direct chat just loses them).
   */
  async eraseAccount(input: { conversationId: string; userId: string }): Promise<RoomResult<null>> {
    if (!(await this.load(input.conversationId))) return { ok: true, value: null };
    const db = this.env.DB;
    const { results: files } = await db
      .prepare('SELECT id FROM attachments WHERE conversation_id = ? AND uploader_id = ?')
      .bind(input.conversationId, input.userId)
      .all<{ id: string }>();
    const rev = this.nextRev();
    const mine = 'SELECT id FROM messages WHERE conversation_id = ?1 AND sender_id = ?2';
    await db.batch([
      db
        .prepare(`DELETE FROM message_envelopes WHERE message_id IN (${mine})`)
        .bind(input.conversationId, input.userId),
      db
        .prepare(
          `UPDATE messages SET deleted_at = COALESCE(deleted_at, ?3), body = '', reply_to_id = NULL,
             attachment_id = NULL, rev = ?4
           WHERE conversation_id = ?1 AND sender_id = ?2 AND kind != 'system'`,
        )
        .bind(input.conversationId, input.userId, Date.now(), rev),
      db
        .prepare('DELETE FROM attachments WHERE conversation_id = ? AND uploader_id = ?')
        .bind(input.conversationId, input.userId),
      this.bumpConversation(null, rev, 0),
    ]);
    if (files.length)
      this.ctx.waitUntil(
        this.env.MEDIA.delete(files.flatMap((f) => attachmentKeys(input.conversationId, f.id))),
      );
    if (this.members.has(input.userId)) {
      if (this.info.kind === 'group') {
        const left = await this.removeMember({
          conversationId: input.conversationId,
          userId: input.userId,
          targetId: input.userId,
        });
        if (!left.ok) return left;
      } else {
        await db
          .prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
          .bind(input.conversationId, input.userId)
          .run();
        this.members.delete(input.userId);
      }
    }
    this.broadcast(this.members.keys(), {
      type: 'conversation',
      conversationId: input.conversationId,
    });
    return { ok: true, value: null };
  }

  /** Remove someone (admin), or leave (anyone, `targetId === userId`). */
  async removeMember(input: {
    conversationId: string;
    userId: string;
    targetId: string;
  }): Promise<RoomResult<Message>> {
    const leaving = input.targetId === input.userId;
    if (leaving) {
      if (!(await this.member(input.conversationId, input.userId)))
        return fail('not_found', 'Conversation not found');
      if (this.info.kind !== 'group') return fail('bad_request', 'You can’t leave a direct chat');
    } else {
      const allowed = await this.groupAdmin(input.conversationId, input.userId);
      if (!allowed.ok) return allowed;
      if (!this.members.has(input.targetId)) return fail('not_found', 'Not a member');
    }
    const db = this.env.DB;
    const statements = [
      db
        .prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
        .bind(input.conversationId, input.targetId),
    ];
    const wasAdmin = this.members.get(input.targetId) === 'admin';
    this.members.delete(input.targetId);
    // A group always keeps an admin: promote the longest-standing member.
    let promoted: string | null = null;
    if (wasAdmin && this.members.size > 0 && ![...this.members.values()].includes('admin')) {
      const next = await db
        .prepare(
          'SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ? ORDER BY joined_at, user_id LIMIT 1',
        )
        .bind(input.conversationId, input.targetId)
        .first<{ user_id: string }>();
      if (next) {
        promoted = next.user_id;
        this.members.set(promoted, 'admin');
        statements.push(
          db
            .prepare(
              "UPDATE conversation_members SET role = 'admin' WHERE conversation_id = ? AND user_id = ?",
            )
            .bind(input.conversationId, promoted),
        );
      }
    }
    const message = await this.systemChange(
      leaving
        ? { action: 'left', actorId: input.userId, targetIds: [], title: null }
        : { action: 'removed', actorId: input.userId, targetIds: [input.targetId], title: null },
      statements,
      [input.targetId],
    );
    if (promoted) {
      await this.systemChange(
        { action: 'promoted', actorId: input.userId, targetIds: [promoted], title: null },
        [],
      );
    }
    return { ok: true, value: message };
  }

  async setRole(input: {
    conversationId: string;
    userId: string;
    targetId: string;
    role: Role;
  }): Promise<RoomResult<Message | null>> {
    const allowed = await this.groupAdmin(input.conversationId, input.userId);
    if (!allowed.ok) return allowed;
    const current = this.members.get(input.targetId);
    if (!current) return fail('not_found', 'Not a member');
    if (current === input.role) return { ok: true, value: null };
    const admins = [...this.members.values()].filter((r) => r === 'admin').length;
    if (input.role === 'member' && admins <= 1)
      return fail('bad_request', 'A group needs at least one admin');
    this.members.set(input.targetId, input.role);
    const message = await this.systemChange(
      {
        action: input.role === 'admin' ? 'promoted' : 'demoted',
        actorId: input.userId,
        targetIds: [input.targetId],
        title: null,
      },
      [
        this.env.DB.prepare(
          'UPDATE conversation_members SET role = ? WHERE conversation_id = ? AND user_id = ?',
        ).bind(input.role, input.conversationId, input.targetId),
      ],
    );
    return { ok: true, value: message };
  }

  /** Forget cached state (e.g. after changes made outside this object). */
  async invalidate(): Promise<void> {
    this.loading = null;
  }
}
