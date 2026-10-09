import type { ConversationSummary, PublicUser } from '@koode/shared';
import * as SQLite from 'expo-sqlite';
import type { LocalMessage, MessagingStore } from './types';

/**
 * SQLite-backed cache so chats open instantly and work offline. Rows hold
 * JSON documents keyed by id; indexes cover the queries we make.
 * Contents are plaintext until end-to-end encryption (Phase 8).
 */
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
        // Keep start-up bounded: the newest 300 messages per conversation.
        messages: parse<LocalMessage>(
          await d.getAllAsync(
            `SELECT doc FROM (
               SELECT doc, ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY COALESCE(seq, 9e15) DESC, created_at DESC) AS r
               FROM messages) WHERE r <= 300`,
          ),
        ),
      };
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
    clear: () => serial(() => store.clear()),
  };
}
