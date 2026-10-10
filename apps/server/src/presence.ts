import type { ServerEvent } from '@koode/shared';

/**
 * Presence: whether someone has a live connection, and when they last did.
 * Shown only to people who share a chat with them, and only while both show
 * theirs (`last_seen_visibility`): hiding mine hides everyone else's from me.
 */

/** People who share a chat with `userId` and show their own presence. */
async function partners(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT b.user_id AS id FROM conversation_members a
       JOIN conversation_members b ON b.conversation_id = a.conversation_id AND b.user_id != a.user_id
       JOIN users u ON u.id = b.user_id AND u.status = 'active' AND u.last_seen_visibility = 'contacts'
       WHERE a.user_id = ?`,
    )
    .bind(userId)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/** Tell partners my presence. Hidden presence goes out once, as "nothing to show". */
export async function publishPresence(env: Env, userId: string, hiddenNow = false): Promise<void> {
  const db = env.DB;
  const me = await db
    .prepare('SELECT online, last_seen_at, last_seen_visibility, status FROM users WHERE id = ?')
    .bind(userId)
    .first<{
      online: number;
      last_seen_at: number | null;
      last_seen_visibility: 'contacts' | 'nobody';
      status: string;
    }>();
  if (!me) return;
  const visible = me.last_seen_visibility === 'contacts' && me.status === 'active';
  if (!visible && !hiddenNow) return;
  const event: Extract<ServerEvent, { type: 'presence' }> = visible
    ? { type: 'presence', userId, online: me.online === 1, lastSeenAt: me.last_seen_at }
    : { type: 'presence', userId, online: false, lastSeenAt: null };
  const payload = JSON.stringify(event);
  await Promise.allSettled(
    (await partners(db, userId)).map((id) =>
      env.USER_SOCKET.get(env.USER_SOCKET.idFromName(id)).deliver(payload),
    ),
  );
}

/** Record a connection change, then tell partners. */
export async function setPresence(env: Env, userId: string, online: boolean, now = Date.now()) {
  await env.DB.prepare('UPDATE users SET online = ?, last_seen_at = ? WHERE id = ?')
    .bind(online ? 1 : 0, now, userId)
    .run();
  await publishPresence(env, userId);
}
