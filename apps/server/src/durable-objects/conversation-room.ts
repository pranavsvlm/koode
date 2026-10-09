import { DurableObject } from 'cloudflare:workers';
import {
  MAX_GROUP_MEMBERS,
  type ApiErrorCode,
  type Message,
  type ServerEvent,
  type SystemEvent,
} from '@koode/shared';
import { attachmentKeys } from '../media/storage';
import {
  hydrate,
  loadMessage,
  MESSAGE_SELECT,
  notifyUsers,
  type MessageRow,
} from '../messaging/rows';
import { pushMessage } from '../push/dispatch';

export type RoomResult<T> =
  { ok: true; value: T } | { ok: false; code: ApiErrorCode; message: string };

const fail = (code: ApiErrorCode, message: string) => ({ ok: false as const, code, message });

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
          'UPDATE conversations SET last_seq = MAX(last_seq, ?), last_rev = MAX(last_rev, ?), last_message_at = ? WHERE id = ?',
        ).bind(seq, rev, now, this.conversationId);
  }

  // ——— Messages ———

  async post(input: {
    conversationId: string;
    senderId: string;
    senderDeviceId: string;
    id: string;
    body: string;
    replyToId?: string | null;
    attachmentId?: string | null;
  }): Promise<RoomResult<Message>> {
    if (!(await this.member(input.conversationId, input.senderId))) {
      return fail('not_found', 'Conversation not found');
    }
    const db = this.env.DB;

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
      return { ok: true, value: (await loadMessage(db, input.conversationId, input.id))! };
    }
    if (input.replyToId) {
      const target = await db
        .prepare('SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?')
        .bind(input.replyToId, input.conversationId)
        .first();
      if (!target) return fail('bad_request', 'Replied-to message not found');
    }
    if (input.attachmentId) {
      // Only my own upload, to this conversation, finished and not sent before.
      const a = await db
        .prepare(
          'SELECT uploaded_at, message_id FROM attachments WHERE id = ? AND conversation_id = ? AND uploader_id = ?',
        )
        .bind(input.attachmentId, input.conversationId, input.senderId)
        .first<{ uploaded_at: number | null; message_id: string | null }>();
      if (!a) return fail('bad_request', 'Attachment not found');
      if (a.uploaded_at === null)
        return fail('bad_request', 'Attachment hasn’t finished uploading');
      if (a.message_id !== null) return fail('conflict', 'Attachment was already sent');
    }

    const seq = ++this.lastSeq;
    const rev = this.nextRev();
    const now = Date.now();
    const kind = input.attachmentId ? 'attachment' : 'text';
    try {
      const results = await db.batch([
        input.attachmentId
          ? db
              .prepare('UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL')
              .bind(input.id, input.attachmentId)
          : db.prepare('SELECT 1'),
        db
          .prepare(
            `INSERT INTO messages (id, conversation_id, seq, rev, sender_id, sender_device_id, kind, body, reply_to_id, attachment_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            input.id,
            input.conversationId,
            seq,
            rev,
            input.senderId,
            input.senderDeviceId,
            kind,
            input.body,
            input.replyToId ?? null,
            input.attachmentId ?? null,
            now,
          ),
        this.bumpConversation(seq, rev, now),
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
      const dup = await loadMessage(db, input.conversationId, input.id);
      if (dup && dup.senderId === input.senderId) return { ok: true, value: dup };
      throw e;
    }

    const message = (await loadMessage(db, input.conversationId, input.id))!;
    this.broadcast(this.members.keys(), { type: 'message', message });
    const recipients = [...this.members.keys()].filter((u) => u !== input.senderId);
    this.ctx.waitUntil(
      pushMessage(this.env, message, this.info, recipients).catch((e: unknown) =>
        console.error(JSON.stringify({ type: 'push_error', message: String(e) })),
      ),
    );
    return { ok: true, value: message };
  }

  private async editable(conversationId: string, messageId: string) {
    return this.env.DB.prepare(`${MESSAGE_SELECT} WHERE m.id = ? AND m.conversation_id = ?`)
      .bind(messageId, conversationId)
      .first<MessageRow>();
  }

  /** Set (or with `emoji: null` remove) my reaction. One per person per message. */
  async react(input: {
    conversationId: string;
    userId: string;
    messageId: string;
    emoji: string | null;
  }): Promise<RoomResult<Message>> {
    if (!(await this.member(input.conversationId, input.userId)))
      return fail('not_found', 'Conversation not found');
    const row = await this.editable(input.conversationId, input.messageId);
    if (!row) return fail('not_found', 'Message not found');
    if (row.deleted_at !== null || row.kind === 'system')
      return fail('bad_request', 'This message can’t be reacted to');

    const db = this.env.DB;
    const rev = this.nextRev();
    await db.batch([
      input.emoji
        ? db
            .prepare(
              'INSERT OR REPLACE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)',
            )
            .bind(input.messageId, input.userId, input.emoji, Date.now())
        : db
            .prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ?')
            .bind(input.messageId, input.userId),
      db.prepare('UPDATE messages SET rev = ? WHERE id = ?').bind(rev, input.messageId),
      this.bumpConversation(null, rev, 0),
    ]);
    const message = (await hydrate(db, [{ ...row, rev }]))[0]!;
    this.broadcast(this.members.keys(), { type: 'message', message });
    return { ok: true, value: message };
  }

  /**
   * Delete for everyone: the sender, or a group admin. The text, file and
   * reactions are erased; the message stays as a "deleted" marker.
   */
  async remove(input: {
    conversationId: string;
    userId: string;
    messageId: string;
  }): Promise<RoomResult<Message>> {
    if (!(await this.member(input.conversationId, input.userId)))
      return fail('not_found', 'Conversation not found');
    const row = await this.editable(input.conversationId, input.messageId);
    if (!row) return fail('not_found', 'Message not found');
    if (row.kind === 'system') return fail('bad_request', 'This message can’t be deleted');
    const isAdmin = this.info.kind === 'group' && this.members.get(input.userId) === 'admin';
    if (row.sender_id !== input.userId && !isAdmin)
      return fail('forbidden', 'You can only delete your own messages');
    if (row.deleted_at !== null)
      return { ok: true, value: (await hydrate(this.env.DB, [row]))[0]! };

    const db = this.env.DB;
    const rev = this.nextRev();
    const now = Date.now();
    await db.batch([
      db
        .prepare(
          "UPDATE messages SET deleted_at = ?, body = '', attachment_id = NULL, rev = ? WHERE id = ?",
        )
        .bind(now, rev, input.messageId),
      db.prepare('DELETE FROM reactions WHERE message_id = ?').bind(input.messageId),
      db.prepare('DELETE FROM attachments WHERE message_id = ?').bind(input.messageId),
      this.bumpConversation(null, rev, 0),
    ]);
    if (row.attachment_id) {
      this.ctx.waitUntil(
        this.env.MEDIA.delete(attachmentKeys(input.conversationId, row.attachment_id)),
      );
    }
    const message = (await loadMessage(db, input.conversationId, input.messageId))!;
    this.broadcast(this.members.keys(), { type: 'message', message });
    return { ok: true, value: message };
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
      db
        .prepare(
          `INSERT INTO messages (id, conversation_id, seq, rev, sender_id, kind, body, system, created_at)
           VALUES (?, ?, ?, ?, ?, 'system', '', ?, ?)`,
        )
        .bind(id, this.conversationId, seq, rev, event.actorId, JSON.stringify(event), now),
      this.bumpConversation(seq, rev, now),
    ]);
    const message = (await loadMessage(db, this.conversationId!, id))!;
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
