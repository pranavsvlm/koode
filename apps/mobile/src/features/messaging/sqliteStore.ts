import type { ConversationSummary, PublicUser } from '@koode/shared';
import * as SQLite from 'expo-sqlite';
import type { LocalMessage, MessagingStore } from './types';

/**
 * SQLite-backed cache so chats open instantly and work offline. Rows hold
 * JSON documents keyed by id; indexes cover the queries we make.
 *
 * Messages arrive end-to-end encrypted and are kept here decrypted (a
 * message can only be decrypted once), protected by the platform's file
 * encryption; the cache is erased at sign-out.
 */
/** Messages per chat loaded at start-up (a screenful or two). */
export const START_MESSAGES = 50;

export function sqliteStore(name = 'koode-messages.db'): MessagingStore {
  // One shared connection; concurrent callers await the same open.
  let opening: Promise<SQLite.SQLiteDatabase> | null = null;

  const open = () =>
    (opening ??= init().catch((e) => {
      opening = null;
      throw e;
    }));

  const init = async () => {
    const db = await SQLite.openDatabaseAsync(name);
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY NOT NULL, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY NOT NULL, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT NOT NULL,
        seq INTEGER,
        created_at INTEGER NOT NULL,
        doc TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages (conversation_id, seq);
      CREATE INDEX IF NOT EXISTS messages_pending ON messages (created_at) WHERE seq IS NULL;
    `);
    return db;
  };

  // Expo SQLite transactions on one connection aren't isolated from each
  // other, so overlapping writes ("cannot start a transaction within a
  // transaction") are prevented by running every operation in order.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const upsert = async (table: 'conversations' | 'users', rows: { id: string }[]) => {
    if (rows.length === 0) return;
    const d = await open();
    await d.withTransactionAsync(async () => {
      for (const r of rows) {
        await d.runAsync(
          `INSERT OR REPLACE INTO ${table} (id, doc) VALUES (?, ?)`,
          r.id,
          JSON.stringify(r),
        );
      }
    });
  };

  const store: MessagingStore = {
    async load() {
      const d = await open();
      const parse = <T>(rows: { doc: string }[]) => rows.map((r) => JSON.parse(r.doc) as T);
      return {
        conversations: parse<ConversationSummary>(
          await d.getAllAsync('SELECT doc FROM conversations'),
        ),
        users: parse<PublicUser>(await d.getAllAsync('SELECT doc FROM users')),
        // Keep start-up light: the newest messages of each chat (one index
        // range each) and anything still in the outbox; older ones are read
        // from here as the user scrolls (`olderMessages`).
        messages: parse<LocalMessage>([
          ...(await d.getAllAsync<{ doc: string }>('SELECT doc FROM messages WHERE seq IS NULL')),
          ...(
            await Promise.all(
              (await d.getAllAsync<{ id: string }>('SELECT id FROM conversations')).map((c) =>
                d.getAllAsync<{ doc: string }>(
                  'SELECT doc FROM messages WHERE conversation_id = ? AND seq IS NOT NULL ORDER BY seq DESC LIMIT ?',
                  c.id,
                  START_MESSAGES,
                ),
              ),
            )
          ).flat(),
        ]),
      };
    },
    async olderMessages(conversationId, beforeSeq, limit) {
      const d = await open();
      const rows = await d.getAllAsync<{ doc: string }>(
        'SELECT doc FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
        conversationId,
        beforeSeq,
        limit,
      );
      return rows.map((r) => JSON.parse(r.doc) as LocalMessage);
    },
    saveConversations: (list) => upsert('conversations', list),
    saveUsers: (list) => upsert('users', list),
    async saveMessages(list) {
      if (list.length === 0) return;
      const d = await open();
      await d.withTransactionAsync(async () => {
        for (const m of list) {
          await d.runAsync(
            'INSERT OR REPLACE INTO messages (id, conversation_id, seq, created_at, doc) VALUES (?, ?, ?, ?, ?)',
            m.id,
            m.conversationId,
            m.seq,
            m.createdAt,
            JSON.stringify(m),
          );
        }
      });
    },
    async getMessages(ids) {
      if (ids.length === 0) return [];
      const d = await open();
      const out: LocalMessage[] = [];
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const rows = await d.getAllAsync<{ doc: string }>(
          `SELECT doc FROM messages WHERE id IN (${chunk.map(() => '?').join(',')})`,
          ...chunk,
        );
        out.push(...rows.map((r) => JSON.parse(r.doc) as LocalMessage));
      }
      return out;
    },
    async deleteMessages(ids) {
      if (ids.length === 0) return;
      const d = await open();
      await d.withTransactionAsync(async () => {
        for (const id of ids) await d.runAsync('DELETE FROM messages WHERE id = ?', id);
      });
    },
    async removeConversation(id) {
      const d = await open();
      await d.withTransactionAsync(async () => {
        await d.runAsync('DELETE FROM messages WHERE conversation_id = ?', id);
        await d.runAsync('DELETE FROM conversations WHERE id = ?', id);
      });
    },
    async clear() {
      const d = await open();
      await d.execAsync('DELETE FROM conversations; DELETE FROM users; DELETE FROM messages;');
    },
  };
  return {
    load: () => serial(() => store.load()),
    saveConversations: (list) => serial(() => store.saveConversations(list)),
    saveUsers: (list) => serial(() => store.saveUsers(list)),
    saveMessages: (list) => serial(() => store.saveMessages(list)),
    getMessages: (ids) => serial(() => store.getMessages(ids)),
    olderMessages: (id, before, limit) => serial(() => store.olderMessages(id, before, limit)),
    deleteMessages: (ids) => serial(() => store.deleteMessages(ids)),
    removeConversation: (id) => serial(() => store.removeConversation(id)),
    clear: () => serial(() => store.clear()),
  };
}
