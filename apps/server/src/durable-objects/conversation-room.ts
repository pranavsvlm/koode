import { DurableObject } from 'cloudflare:workers';
import type { ApiErrorCode, Message, ServerEvent } from '@koode/shared';
import { MESSAGE_COLUMNS, notifyUsers, toMessage, type MessageRow } from '../messaging/rows';

export type RoomResult<T> =
  { ok: true; value: T } | { ok: false; code: ApiErrorCode; message: string };

const fail = (code: ApiErrorCode, message: string) => ({ ok: false as const, code, message });

/**
 * One instance per conversation: the single writer for its message sequence,
 * so ordering is strict without cross-request locking, and the fan-out point
 * for messages, receipts and typing. Durable data lives in D1.
 */
export class ConversationRoom extends DurableObject<Env> {
  private conversationId: string | null = null;
  private loading: Promise<boolean> | null = null;
  private lastSeq = 0;
  private members = new Set<string>();

  /** Load the sequence counter and membership once per activation. */
  private load(conversationId: string): Promise<boolean> {
    if (this.loading && this.conversationId === conversationId) return this.loading;
    this.conversationId = conversationId;
    this.loading = (async () => {
      const db = this.env.DB;
      const conv = await db
        .prepare('SELECT last_seq FROM conversations WHERE id = ?')
        .bind(conversationId)
        .first<{ last_seq: number }>();
      if (!conv) return false;
      const { results } = await db
        .prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?')
        .bind(conversationId)
        .all<{ user_id: string }>();
      this.lastSeq = Math.max(this.lastSeq, conv.last_seq);
      this.members = new Set(results.map((r) => r.user_id));
      return true;
    })().catch((e) => {
      this.loading = null;
      throw e;
    });
    return this.loading;
  }

  private broadcast(userIds: Iterable<string>, event: ServerEvent) {
    this.ctx.waitUntil(notifyUsers(this.env, userIds, event));
  }

  async post(input: {
    conversationId: string;
    senderId: string;
    senderDeviceId: string;
    id: string;
    body: string;
    replyToId?: string | null;
  }): Promise<RoomResult<Message>> {
    if (!(await this.load(input.conversationId)) || !this.members.has(input.senderId)) {
      return fail('not_found', 'Conversation not found');
    }
    const db = this.env.DB;

    // Idempotent retries: the client's message id is the key.
    const existing = await db
      .prepare(`SELECT ${MESSAGE_COLUMNS}, sender_id FROM messages WHERE id = ?`)
      .bind(input.id)
      .first<MessageRow>();
    if (existing) {
      return existing.conversation_id === input.conversationId &&
        existing.sender_id === input.senderId
        ? { ok: true, value: toMessage(existing) }
        : fail('conflict', 'Message id already used');
    }
    if (input.replyToId) {
      const target = await db
        .prepare('SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?')
        .bind(input.replyToId, input.conversationId)
        .first();
      if (!target) return fail('bad_request', 'Replied-to message not found');
    }

    // Synchronous increment: concurrent posts in this instance can't share a seq.
    const seq = ++this.lastSeq;
    const now = Date.now();
    const row: MessageRow = {
      id: input.id,
      conversation_id: input.conversationId,
      seq,
      sender_id: input.senderId,
      body: input.body,
      reply_to_id: input.replyToId ?? null,
      created_at: now,
    };
    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO messages (id, conversation_id, seq, sender_id, sender_device_id, body, reply_to_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            row.id,
            row.conversation_id,
            seq,
            row.sender_id,
            input.senderDeviceId,
            row.body,
            row.reply_to_id,
            now,
          ),
        db
          .prepare(
            'UPDATE conversations SET last_seq = MAX(last_seq, ?), last_message_at = ? WHERE id = ?',
          )
          .bind(seq, now, input.conversationId),
        // The sender has obviously seen their own message.
        db
          .prepare(
            `UPDATE conversation_members SET last_delivered_seq = MAX(last_delivered_seq, ?1),
               last_read_seq = MAX(last_read_seq, ?1), shared_read_seq = MAX(shared_read_seq, ?1)
             WHERE conversation_id = ?2 AND user_id = ?3`,
          )
          .bind(seq, input.conversationId, input.senderId),
      ]);
    } catch (e) {
      // Lost a race with a duplicate send of the same id: return the stored copy.
      const dup = await db
        .prepare(`SELECT ${MESSAGE_COLUMNS}, sender_id FROM messages WHERE id = ?`)
        .bind(input.id)
        .first<MessageRow>();
      if (dup && dup.conversation_id === input.conversationId && dup.sender_id === input.senderId) {
        return { ok: true, value: toMessage(dup) };
      }
      throw e;
    }

    const message = toMessage(row);
    this.broadcast(this.members, { type: 'message', message });
    return { ok: true, value: message };
  }

  async receipt(input: {
    conversationId: string;
    userId: string;
    delivered?: number;
    read?: number;
    shareRead: boolean;
  }): Promise<RoomResult<{ deliveredSeq: number; readSeq: number }>> {
    if (!(await this.load(input.conversationId)) || !this.members.has(input.userId)) {
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
    const others = [...this.members].filter((m) => m !== input.userId);
    this.broadcast(others, { ...base, readSeq: row.shared_read_seq });
    this.broadcast([input.userId], { ...base, readSeq: row.last_read_seq }); // my other devices
    return {
      ok: true,
      value: { deliveredSeq: row.last_delivered_seq, readSeq: row.last_read_seq },
    };
  }

  async typing(input: { conversationId: string; userId: string }): Promise<RoomResult<null>> {
    if (!(await this.load(input.conversationId)) || !this.members.has(input.userId)) {
      return fail('not_found', 'Conversation not found');
    }
    const others = [...this.members].filter((m) => m !== input.userId);
    this.broadcast(others, {
      type: 'typing',
      conversationId: input.conversationId,
      userId: input.userId,
    });
    return { ok: true, value: null };
  }

  /** Call after membership changes (group administration, Phase 7). */
  async invalidate(): Promise<void> {
    this.loading = null;
  }
}
