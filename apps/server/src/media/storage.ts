/**
 * Attachment files in the private R2 bucket. Keys are scoped by conversation;
 * nothing is public: every read goes through an authorized Worker route.
 */
export const contentKey = (conversationId: string, attachmentId: string) =>
  `att/${conversationId}/${attachmentId}`;
export const thumbnailKey = (conversationId: string, attachmentId: string) =>
  `att/${conversationId}/${attachmentId}/thumb`;
export const attachmentKeys = (conversationId: string, attachmentId: string) => [
  contentKey(conversationId, attachmentId),
  thumbnailKey(conversationId, attachmentId),
];

/** Uploads that were never sent in a message are removed after this long. */
export const UNSENT_TTL_MS = 24 * 3600_000;

/** Deletes unsent attachments older than the TTL (files and rows). Returns how many. */
export async function cleanupUnsent(env: Env, now = Date.now()): Promise<number> {
  const db = env.DB;
  let removed = 0;
  for (;;) {
    const { results } = await db
      .prepare(
        'SELECT id, conversation_id FROM attachments WHERE message_id IS NULL AND created_at < ? LIMIT 200',
      )
      .bind(now - UNSENT_TTL_MS)
      .all<{ id: string; conversation_id: string }>();
    if (results.length === 0) return removed;
    await env.MEDIA.delete(results.flatMap((r) => attachmentKeys(r.conversation_id, r.id)));
    await db.batch(
      results.map((r) =>
        db.prepare('DELETE FROM attachments WHERE id = ? AND message_id IS NULL').bind(r.id),
      ),
    );
    removed += results.length;
  }
}
