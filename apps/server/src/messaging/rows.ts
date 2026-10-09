import type {
  AttachmentMeta,
  ConversationMember,
  ConversationSummary,
  Message,
  Reaction,
  SystemEvent,
} from '@koode/shared';

/** A message joined with its attachment's metadata (`a_*`). */
export type MessageRow = {
  id: string;
  conversation_id: string;
  seq: number;
  rev: number;
  sender_id: string;
  kind: Message['kind'];
  body: string;
  reply_to_id: string | null;
  attachment_id: string | null;
  system: string | null;
  deleted_at: number | null;
  created_at: number;
  a_kind: AttachmentMeta['kind'] | null;
  a_mime: string | null;
  a_size: number | null;
  a_name: string | null;
  a_width: number | null;
  a_height: number | null;
  a_duration: number | null;
  a_waveform: string | null;
  a_preview: string | null;
  a_thumb: number | null;
};

/** `SELECT … FROM messages m` with attachment metadata; append WHERE/ORDER. */
export const MESSAGE_SELECT = `SELECT m.id, m.conversation_id, m.seq, m.rev, m.sender_id, m.kind, m.body,
  m.reply_to_id, m.attachment_id, m.system, m.deleted_at, m.created_at,
  a.kind AS a_kind, a.mime_type AS a_mime, a.size_bytes AS a_size, a.name AS a_name,
  a.width AS a_width, a.height AS a_height, a.duration_ms AS a_duration,
  a.waveform AS a_waveform, a.preview AS a_preview, a.has_thumbnail AS a_thumb
  FROM messages m LEFT JOIN attachments a ON a.id = m.attachment_id`;

function parseJson<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

export const toMessage = (r: MessageRow, reactions: Reaction[] = []): Message => ({
  id: r.id,
  conversationId: r.conversation_id,
  seq: r.seq,
  rev: r.rev,
  senderId: r.sender_id,
  kind: r.kind,
  body: r.body,
  replyToId: r.reply_to_id,
  attachment:
    r.attachment_id && r.a_kind
      ? {
          id: r.attachment_id,
          kind: r.a_kind,
          mimeType: r.a_mime ?? 'application/octet-stream',
          sizeBytes: r.a_size ?? 0,
          name: r.a_name,
          width: r.a_width,
          height: r.a_height,
          durationMs: r.a_duration,
          waveform: parseJson<number[]>(r.a_waveform),
          preview: r.a_preview,
          hasThumbnail: !!r.a_thumb,
        }
      : null,
  system: parseJson<SystemEvent>(r.system),
  reactions,
  deletedAt: r.deleted_at,
  createdAt: r.created_at,
});

/** Rows → messages, with their reactions (one extra query per 90 messages). */
export async function hydrate(db: D1Database, rows: MessageRow[]): Promise<Message[]> {
  const byMessage = new Map<string, Reaction[]>();
  for (let i = 0; i < rows.length; i += 90) {
    const ids = rows.slice(i, i + 90).map((r) => r.id);
    const { results } = await db
      .prepare(
        `SELECT message_id, user_id, emoji FROM reactions WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at`,
      )
      .bind(...ids)
      .all<{ message_id: string; user_id: string; emoji: string }>();
    for (const r of results) {
      const list = byMessage.get(r.message_id) ?? [];
      list.push({ userId: r.user_id, emoji: r.emoji });
      byMessage.set(r.message_id, list);
    }
  }
  return rows.map((r) => toMessage(r, byMessage.get(r.id) ?? []));
}

export async function loadMessage(
  db: D1Database,
  conversationId: string,
  id: string,
): Promise<Message | null> {
  const row = await db
    .prepare(`${MESSAGE_SELECT} WHERE m.id = ? AND m.conversation_id = ?`)
    .bind(id, conversationId)
    .first<MessageRow>();
  return row ? (await hydrate(db, [row]))[0]! : null;
}

type ConversationRow = {
  id: string;
  kind: 'direct' | 'group';
  title: string | null;
  created_at: number;
  last_seq: number;
  last_rev: number;
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
        `SELECT c.id, c.kind, c.title, c.created_at, c.last_seq, c.last_rev FROM conversations c
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
        `${MESSAGE_SELECT}
         JOIN conversations c ON c.id = m.conversation_id AND m.seq = c.last_seq
         WHERE c.id IN (${mine})`,
      )
      .bind(userId),
    db
      .prepare(
        `SELECT m.conversation_id, COUNT(*) AS n FROM messages m
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
         WHERE m.seq > cm.last_read_seq AND m.sender_id != ? AND m.kind != 'system'
           AND m.deleted_at IS NULL GROUP BY m.conversation_id`,
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
    (await hydrate(db, lasts!.results as MessageRow[])).map((m) => [m.conversationId, m]),
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
    lastRev: c.last_rev,
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
