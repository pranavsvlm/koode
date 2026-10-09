import type { ConversationSummary } from '@koode/shared';
import { Directory, File, Paths } from 'expo-file-system';
import * as SQLite from 'expo-sqlite';
import { decryptFile, encryptFile } from '@/features/crypto';
import type { Snapshot } from '@/features/messaging';
import { normalizeMessage } from '@/features/messaging/types';
import { deriveLive } from '@/stores/chat';

/**
 * On-device measurements (EXPO_PUBLIC_DEV_TOUR=perf), logged as
 * `[tour-perf] <label> <json>`. The runner samples the app's memory while
 * the file steps run. Everything here uses scratch data, never the account's.
 */
export const perfLog = (label: string, value: unknown) =>
  console.log(`[tour-perf] ${label} ${JSON.stringify(value)}`);

const ms = (t: number) => Math.round((performance.now() - t) * 10) / 10;
const scratch = () => {
  const d = new Directory(Paths.cache, 'perf');
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
};

const CHATS = 50;
const PER_CHAT = 2000;

/** A cache shaped like the app's, with 100k realistic message documents. */
export async function seedCache() {
  const t = performance.now();
  const db = await SQLite.openDatabaseAsync('perf.db');
  await db.execAsync(`
    DROP TABLE IF EXISTS conversations; DROP TABLE IF EXISTS messages;
    CREATE TABLE conversations (id TEXT PRIMARY KEY NOT NULL, doc TEXT NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL, seq INTEGER, created_at INTEGER NOT NULL, doc TEXT NOT NULL);
    CREATE INDEX messages_conversation ON messages (conversation_id, seq);
    CREATE INDEX messages_pending ON messages (created_at) WHERE seq IS NULL;`);
  await db.withTransactionAsync(async () => {
    const insert = await db.prepareAsync('INSERT INTO messages VALUES (?, ?, ?, ?, ?)');
    try {
      for (let c = 0; c < CHATS; c++) {
        await db.runAsync('INSERT INTO conversations VALUES (?, ?)', `c${c}`, '{}');
        for (let i = 1; i <= PER_CHAT; i++) {
          const doc = JSON.stringify(
            normalizeMessage({
              id: `c${c}-${i}`,
              conversationId: `c${c}`,
              seq: i,
              rev: i,
              senderId: i % 2 ? 'usr_a' : 'usr_b',
              body: 'Are we still on for dinner tomorrow? I can bring dessert 🍰',
              createdAt: 1_791_500_000_000 + i,
              opened: true,
            }),
          );
          await insert.executeAsync(`c${c}-${i}`, `c${c}`, i, i, doc);
        }
      }
    } finally {
      await insert.finalizeAsync();
    }
  });
  await db.closeAsync();
  perfLog('seeded', { messages: CHATS * PER_CHAT, ms: ms(t) });
}

/** Start-up cache read: the old window-function query vs the indexed one. */
export async function measureStartupQueries() {
  const db = await SQLite.openDatabaseAsync('perf.db');
  const parse = (rows: { doc: string }[]) => rows.map((r) => JSON.parse(r.doc) as unknown).length;
  const run = async (fn: () => Promise<number>) => {
    await fn(); // warm-up
    const times: number[] = [];
    let n = 0;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      n = await fn();
      times.push(ms(t));
    }
    return { ms: Math.min(...times), messages: n };
  };
  const before = await run(async () =>
    parse(
      await db.getAllAsync<{ doc: string }>(
        `SELECT doc FROM (SELECT doc, ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY COALESCE(seq, 9e15) DESC, created_at DESC) AS r FROM messages) WHERE r <= 300`,
      ),
    ),
  );
  const after = await run(async () => {
    const rows = await db.getAllAsync<{ doc: string }>(
      'SELECT doc FROM messages WHERE seq IS NULL',
    );
    const chats = await db.getAllAsync<{ id: string }>('SELECT id FROM conversations');
    const lists = await Promise.all(
      chats.map((c) =>
        db.getAllAsync<{ doc: string }>(
          'SELECT doc FROM messages WHERE conversation_id = ? AND seq IS NOT NULL ORDER BY seq DESC LIMIT 50',
          c.id,
        ),
      ),
    );
    return parse([...rows, ...lists.flat()]);
  });
  await db.closeAsync();
  perfLog('startup-cache', { before, after });
}

/** Rendering model: cost of a typing event and of a new message (Hermes). */
export function measureDerive() {
  const conversations: ConversationSummary[] = [];
  const messages: Snapshot['messages'] = {};
  for (let c = 0; c < CHATS; c++) {
    conversations.push({
      id: `c${c}`,
      kind: 'direct',
      title: null,
      createdAt: 0,
      lastSeq: 50,
      lastRev: 50,
      lastMessage: null,
      unreadCount: 0,
      members: [
        { userId: 'me', role: 'member', lastDeliveredSeq: 50, lastReadSeq: 50 },
        { userId: 'b', role: 'member', lastDeliveredSeq: 50, lastReadSeq: 40 },
      ],
    });
    messages[`c${c}`] = Array.from({ length: 50 }, (_, i) =>
      normalizeMessage({
        id: `c${c}m${i}`,
        conversationId: `c${c}`,
        seq: i + 1,
        rev: i + 1,
        senderId: i % 2 ? 'me' : 'b',
        body: 'hello there',
        createdAt: i,
      }),
    );
  }
  const overlay = { reactions: {}, deleted: {}, pinned: {}, muted: {} };
  let snap: Snapshot = {
    connection: 'online',
    conversations,
    messages,
    users: {},
    typing: {},
    hasMore: {},
    progress: {},
  };
  deriveLive(snap, 'me', overlay, true);
  let t = performance.now();
  for (let i = 0; i < 20; i++) {
    snap = { ...snap, typing: { c1: i % 2 ? ['b'] : [] } };
    deriveLive(snap, 'me', overlay, true);
  }
  const typing = ms(t) / 20;
  t = performance.now();
  for (let i = 0; i < 20; i++) {
    const list = snap.messages.c1!;
    snap = {
      ...snap,
      messages: {
        ...snap.messages,
        c1: [...list, { ...list[0]!, id: `new${i}`, seq: 100 + i, rev: 100 + i }],
      },
    };
    deriveLive(snap, 'me', overlay, true);
  }
  perfLog('derive', { typingEventMs: typing, newMessageMs: ms(t) / 20, chats: CHATS, perChat: 50 });
}

/** Encrypt and decrypt a 100 MB file (the runner watches memory meanwhile). */
export async function measureFileCrypto() {
  const dir = scratch();
  const plain = new File(dir, 'big.bin');
  if (!plain.exists) {
    plain.create();
    const chunk = new Uint8Array(1 << 20);
    for (let i = 0; i < chunk.length; i++) chunk[i] = i % 251;
    const handle = plain.open();
    for (let i = 0; i < 100; i++) handle.writeBytes(chunk);
    handle.close();
  }
  const sealed = new File(dir, 'big.sealed');
  const opened = new File(dir, 'big.opened');
  perfLog('file-start', { bytes: plain.size });
  let t = performance.now();
  const secret = await encryptFile(plain.uri, sealed.uri);
  const encryptMs = ms(t);
  t = performance.now();
  await decryptFile(sealed.uri, opened.uri, secret);
  const decryptMs = ms(t);
  perfLog('file-crypto', {
    bytes: plain.size,
    sealed: secret.size,
    encryptMs,
    decryptMs,
    roundTrip: opened.size === plain.size,
  });
  for (const f of [sealed, opened]) if (f.exists) f.delete();
}
