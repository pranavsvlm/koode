import type { ConversationMember, ConversationSummary, Message } from '@koode/shared';

export type MessageRow = {
  id: string;
  conversation_id: string;
  seq: number;
  sender_id: string;
  body: string;
  reply_to_id: string | null;
  created_at: number;
};

export const MESSAGE_COLUMNS = 'id, conversation_id, seq, sender_id, body, reply_to_id, created_at';

export const toMessage = (r: MessageRow): Message => ({
  id: r.id,
  conversationId: r.conversation_id,
  seq: r.seq,
  senderId: r.sender_id,
  body: r.body,
  replyToId: r.reply_to_id,
  createdAt: r.created_at,
});

type ConversationRow = {
  id: string;
  kind: 'direct' | 'group';
  title: string | null;
  created_at: number;
  last_seq: number;
};
type MemberRow = {
  conversation_id: string;
  user_id: string;
  role: 'member' | 'admin';
  last_delivered_seq: number;
  last_read_seq: number;
  shared_read_seq: number;
};

/**
 * Conversation summaries for `userId`, optionally limited to one conversation.
 * Other members' read positions are the *shared* ones (read-receipt privacy).
 */
export async function loadSummaries(
  db: D1Database,
  userId: string,
  onlyId?: string,
): Promise<ConversationSummary[]> {
  const scope = onlyId ? 'AND c.id = ?' : '';
  const mine = `SELECT conversation_id FROM conversation_members WHERE user_id = ?`;
  const binds = (extra: unknown[] = []) =>
    onlyId ? [userId, ...extra, onlyId] : [userId, ...extra];

  const [convs, members, lasts, unread] = await db.batch<unknown>([
    db
      .prepare(
        `SELECT c.id, c.kind, c.title, c.created_at, c.last_seq FROM conversations c
         JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ? ${scope}
         ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
      )
      .bind(...binds()),
    db
      .prepare(
        `SELECT conversation_id, user_id, role, last_delivered_seq, last_read_seq, shared_read_seq
         FROM conversation_members WHERE conversation_id IN (${mine})`,
      )
      .bind(userId),
    db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS.split(', ')
          .map((c) => `m.${c}`)
          .join(', ')} FROM messages m
         JOIN conversations c ON c.id = m.conversation_id AND m.seq = c.last_seq
         WHERE c.id IN (${mine})`,
      )
      .bind(userId),
    db
      .prepare(
        `SELECT m.conversation_id, COUNT(*) AS n FROM messages m
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
         WHERE m.seq > cm.last_read_seq AND m.sender_id != ? GROUP BY m.conversation_id`,
      )
      .bind(userId, userId),
  ]);

  const membersBy = new Map<string, ConversationMember[]>();
  for (const m of members!.results as MemberRow[]) {
    const list = membersBy.get(m.conversation_id) ?? [];
    list.push({
      userId: m.user_id,
      role: m.role,
      lastDeliveredSeq: m.last_delivered_seq,
      lastReadSeq: m.user_id === userId ? m.last_read_seq : m.shared_read_seq,
    });
    membersBy.set(m.conversation_id, list);
  }
  const lastBy = new Map(
    (lasts!.results as MessageRow[]).map((r) => [r.conversation_id, toMessage(r)]),
  );
  const unreadBy = new Map(
    (unread!.results as { conversation_id: string; n: number }[]).map((r) => [
      r.conversation_id,
      r.n,
    ]),
  );

  return (convs!.results as ConversationRow[]).map((c) => ({
    id: c.id,
    kind: c.kind,
    title: c.title,
    createdAt: c.created_at,
    lastSeq: c.last_seq,
    lastMessage: lastBy.get(c.id) ?? null,
    members: membersBy.get(c.id) ?? [],
    unreadCount: unreadBy.get(c.id) ?? 0,
  }));
}

/** Push a realtime event to every connected device of each user. Best effort. */
export function notifyUsers(env: Env, userIds: Iterable<string>, event: unknown): Promise<unknown> {
  const payload = JSON.stringify(event);
  return Promise.allSettled(
    [...new Set(userIds)].map((uid) =>
      env.USER_SOCKET.get(env.USER_SOCKET.idFromName(uid)).deliver(payload),
    ),
  );
}
