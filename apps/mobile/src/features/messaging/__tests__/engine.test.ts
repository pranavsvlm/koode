import type { AttachmentMeta, ConversationSummary, Message } from '@koode/shared';
import { ApiClientError } from '@/lib/api';
import {
  HEARTBEAT_MS,
  MessagingEngine,
  PONG_TIMEOUT_MS,
  TYPING_THROTTLE_MS,
  TYPING_TTL_MS,
  type MessagingApi,
  type SocketLike,
} from '../engine';
import { memoryStore } from '../types';

// ——— Test doubles ———

function fakeClock() {
  let now = 1_000_000;
  let nextId = 1;
  const tasks = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextId++;
      tasks.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id: unknown) => void tasks.delete(id as number),
    /** Advance time, running due timers in order (and settling promises between). */
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...tasks.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        tasks.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = target;
      await flush();
    },
    pending: () => [...tasks.values()].map((t) => t.at - now).sort((a, b) => a - b),
  };
}

/** Let every pending promise chain settle (engine timers stay on the fake clock). */
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onclose: ((code: number) => void) | null = null;
  constructor(public token: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.(1000);
  }
  open() {
    this.onopen?.();
  }
  receive(event: unknown) {
    this.onmessage?.(JSON.stringify(event));
  }
}

const ME = 'usr_me';
const MAYA = 'usr_maya';

function fakeServer() {
  const state = {
    online: true,
    conversations: new Map<string, ConversationSummary>(),
    messages: new Map<string, Message[]>(),
    receipts: [] as { id: string; body: unknown }[],
    sends: [] as string[],
    rejectSend: null as ApiClientError | null,
    attachments: new Map<string, AttachmentMeta>(),
    uploads: [] as { id: string; part: string; uri: string }[],
    failUpload: null as ApiClientError | null,
    expireUploads: false,
  };
  const ensureOnline = () => {
    if (!state.online) throw new ApiClientError('network', 'offline');
  };
  const addConversation = (id: string) => {
    state.conversations.set(id, {
      id,
      kind: 'direct',
      title: null,
      createdAt: 1,
      lastSeq: 0,
      lastRev: 0,
      lastMessage: null,
      unreadCount: 0,
      members: [
        { userId: ME, role: 'member', lastDeliveredSeq: 0, lastReadSeq: 0 },
        { userId: MAYA, role: 'member', lastDeliveredSeq: 0, lastReadSeq: 0 },
      ],
    });
    state.messages.set(id, []);
  };
  const post = (
    conversationId: string,
    senderId: string,
    body: string,
    id = `m-${Math.random()}`,
    attachmentId: string | null = null,
  ) => {
    const list = state.messages.get(conversationId)!;
    const existing = list.find((m) => m.id === id);
    if (existing) return existing;
    const c = state.conversations.get(conversationId)!;
    const msg: Message = {
      id,
      conversationId,
      seq: c.lastSeq + 1,
      rev: c.lastRev + 1,
      senderId,
      kind: attachmentId ? 'attachment' : 'text',
      body,
      replyToId: null,
      attachment: attachmentId ? state.attachments.get(attachmentId)! : null,
      system: null,
      reactions: [],
      deletedAt: null,
      createdAt: 2_000_000 + c.lastSeq,
    };
    list.push(msg);
    state.conversations.set(conversationId, {
      ...c,
      lastSeq: msg.seq,
      lastRev: msg.rev,
      lastMessage: msg,
    });
    return msg;
  };
  /** Change an existing message on the server (new revision). */
  const edit = (conversationId: string, id: string, patch: Partial<Message>) => {
    const c = state.conversations.get(conversationId)!;
    const list = state.messages.get(conversationId)!;
    const i = list.findIndex((m) => m.id === id);
    const next = { ...list[i]!, ...patch, rev: c.lastRev + 1 };
    list[i] = next;
    state.conversations.set(conversationId, { ...c, lastRev: next.rev });
    return next;
  };
  const api: MessagingApi = {
    getAccessToken: async () => {
      ensureOnline();
      return 'token';
    },
    users: async () => {
      ensureOnline();
      return [{ id: MAYA, username: 'maya', displayName: 'Maya', about: '' }];
    },
    conversations: async () => {
      ensureOnline();
      return [...state.conversations.values()];
    },
    conversation: async (id) => {
      ensureOnline();
      return state.conversations.get(id)!;
    },
    messages: async (id, { before, after, changedSince, limit = 50 }) => {
      ensureOnline();
      const all = state.messages.get(id)!;
      if (changedSince !== undefined) {
        const rows = all.filter((m) => m.rev > changedSince).sort((a, b) => a.rev - b.rev);
        return { messages: rows.slice(0, limit), hasMore: rows.length > limit };
      }
      if (after !== undefined) {
        const rows = all.filter((m) => m.seq > after);
        return { messages: rows.slice(0, limit), hasMore: rows.length > limit };
      }
      const rows = all.filter((m) => m.seq < (before ?? Infinity));
      return { messages: rows.slice(-limit), hasMore: rows.length > limit };
    },
    send: async (id, body) => {
      ensureOnline();
      if (state.rejectSend) throw state.rejectSend;
      state.sends.push(body.body);
      return post(id, ME, body.body, body.id, body.attachmentId ?? null);
    },
    receipts: async (id, body) => {
      ensureOnline();
      state.receipts.push({ id, body });
      return {};
    },
    createConversation: async () => {
      ensureOnline();
      addConversation('c-new');
      return state.conversations.get('c-new')!;
    },
    createAttachment: async (_id, body) => {
      ensureOnline();
      const meta: AttachmentMeta = {
        id: `att-${state.attachments.size + 1}`,
        kind: body.kind,
        mimeType: body.mimeType,
        sizeBytes: body.sizeBytes,
        name: body.kind === 'document' ? body.name : null,
        width: 'width' in body ? body.width : null,
        height: 'height' in body ? body.height : null,
        durationMs: 'durationMs' in body ? body.durationMs : null,
        waveform: body.kind === 'voice' ? body.waveform : null,
        preview: null,
        hasThumbnail: false,
      };
      state.attachments.set(meta.id, meta);
      return meta;
    },
    upload: async (attachmentId, part, file, onProgress) => {
      ensureOnline();
      if (state.expireUploads) {
        state.expireUploads = false;
        throw new ApiClientError('not_found', 'Attachment not found', 404);
      }
      if (state.failUpload) throw state.failUpload;
      onProgress(0.5);
      state.uploads.push({ id: attachmentId, part, uri: file.uri });
      onProgress(1);
    },
    react: async (id, messageId, emoji) => {
      ensureOnline();
      const m = state.messages.get(id)!.find((x) => x.id === messageId)!;
      const others = m.reactions.filter((r) => r.userId !== ME);
      return edit(id, messageId, {
        reactions: emoji ? [...others, { userId: ME, emoji }] : others,
      });
    },
    deleteMessage: async (id, messageId) => {
      ensureOnline();
      return edit(id, messageId, { body: '', attachment: null, reactions: [], deletedAt: 1 });
    },
    renameGroup: async (id) => state.conversations.get(id)!,
    addMembers: async (id) => state.conversations.get(id)!,
    setRole: async (id) => state.conversations.get(id)!,
    removeMember: async (id) => {
      ensureOnline();
      state.conversations.delete(id);
      return {};
    },
  };
  return { state, api, addConversation, post, edit };
}

function setup(
  opts: { readReceipts?: boolean; typingIndicators?: boolean; seedRandom?: number } = {},
) {
  const clock = fakeClock();
  const server = fakeServer();
  const store = memoryStore();
  const sockets: FakeSocket[] = [];
  const onSignedOut = jest.fn();
  let n = 0;
  const engine = new MessagingEngine({
    me: ME,
    api: server.api,
    connect: (token) => {
      const s = new FakeSocket(token);
      sockets.push(s);
      return s;
    },
    store,
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    prefs: () => ({
      readReceipts: opts.readReceipts ?? true,
      typingIndicators: opts.typingIndicators ?? true,
    }),
    onSignedOut,
    isSignedOutError: (e) => e instanceof Error && e.message === 'signed out',
    now: clock.now,
    random: () => opts.seedRandom ?? 1,
    timers: clock,
  });
  const socket = () => sockets.at(-1)!;
  const online = async () => {
    await flush();
    socket().open();
    await flush();
  };
  return { clock, server, store, engine, sockets, socket, online, onSignedOut };
}

const bodies = (engine: MessagingEngine, id: string) =>
  (engine.getSnapshot().messages[id] ?? []).map((m) => m.body);

// ——— Tests ———

describe('MessagingEngine', () => {
  it('connects, syncs conversations and fetches the newest page for new chats', async () => {
    const t = setup();
    t.server.addConversation('c1');
    t.server.post('c1', MAYA, 'hello');
    t.server.post('c1', MAYA, 'are you there?');
    await t.engine.start();
    expect(t.engine.getSnapshot().connection).toBe('connecting');
    await t.online();
    expect(t.engine.getSnapshot().connection).toBe('online');
    expect(bodies(t.engine, 'c1')).toEqual(['hello', 'are you there?']);
    expect(t.engine.getSnapshot().users[MAYA]?.displayName).toBe('Maya');
    // Delivery is acknowledged in one batched receipt.
    await t.clock.advance(500);
    expect(t.server.state.receipts).toEqual([
      { id: 'c1', body: { delivered: 2, shareRead: true } },
    ]);
  });

  it('shows sent messages immediately and confirms them with a server seq', async () => {
    const t = setup();
    t.server.addConversation('c1');
    await t.engine.start();
    await t.online();
    const local = t.engine.send('c1', '  hi Maya  ');
    expect(t.engine.getSnapshot().messages.c1![0]).toMatchObject({
      id: local.id,
      body: 'hi Maya',
      state: 'pending',
      seq: null,
    });
    await flush();
    expect(t.engine.getSnapshot().messages.c1![0]).toMatchObject({
      id: local.id,
      state: 'sent',
      seq: 1,
    });
    // The server echo over the socket doesn't duplicate it.
    t.socket().receive({ type: 'message', message: t.server.state.messages.get('c1')![0] });
    expect(bodies(t.engine, 'c1')).toEqual(['hi Maya']);
  });

  it('keeps messages queued offline and delivers them in order after reconnecting', async () => {
    const t = setup();
    t.server.addConversation('c1');
    await t.engine.start();
    await t.online();
    t.server.state.online = false;
    t.engine.send('c1', 'first');
    t.engine.send('c1', 'second');
    await flush();
    expect(t.engine.getSnapshot().messages.c1!.map((m) => m.state)).toEqual(['pending', 'pending']);
    expect(t.store.dump().messages.filter((m) => m.state === 'pending')).toHaveLength(2); // survives restarts

    t.socket().close();
    t.server.state.online = true;
    await t.clock.advance(1000);
    t.socket().open();
    await flush();
    expect(t.server.state.sends).toEqual(['first', 'second']);
    expect(t.engine.getSnapshot().messages.c1!.map((m) => [m.body, m.seq])).toEqual([
      ['first', 1],
      ['second', 2],
    ]);
  });

  it('marks permanently rejected messages failed and can retry them', async () => {
    const t = setup();
    t.server.addConversation('c1');
    await t.engine.start();
    await t.online();
    t.server.state.rejectSend = new ApiClientError('bad_request', 'nope', 400);
    const m = t.engine.send('c1', 'oops');
    await flush();
    expect(t.engine.getSnapshot().messages.c1![0]!.state).toBe('failed');
    t.server.state.rejectSend = null;
    t.engine.retry(m.id);
    await flush();
    expect(t.engine.getSnapshot().messages.c1![0]!.state).toBe('sent');
  });

  it('reconnects with capped exponential backoff and resets after success', async () => {
    const t = setup({ seedRandom: 1 }); // jitter factor 1.0 → full delay
    await t.engine.start();
    await t.online();
    t.server.state.online = false;
    t.socket().close();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      delays.push(t.clock.pending()[0]!);
      await t.clock.advance(t.clock.pending()[0]!); // token fetch fails → schedules next
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    t.server.state.online = true;
    await t.clock.advance(t.clock.pending()[0]!);
    t.socket().open();
    await flush();
    expect(t.engine.getSnapshot().connection).toBe('online');
    t.socket().close();
    expect(t.clock.pending()[0]).toBe(1000);
  });

  it('detects a dead connection when a heartbeat goes unanswered', async () => {
    const t = setup();
    await t.engine.start();
    await t.online();
    await t.clock.advance(HEARTBEAT_MS);
    expect(t.socket().sent).toContain('{"type":"ping"}');
    await t.clock.advance(PONG_TIMEOUT_MS);
    expect(t.sockets[0]!.closed).toBe(true);
    expect(t.engine.getSnapshot().connection).toBe('offline');
  });

  it('keeps the connection when the server answers the heartbeat', async () => {
    const t = setup();
    await t.engine.start();
    await t.online();
    await t.clock.advance(HEARTBEAT_MS);
    t.socket().receive({ type: 'pong' });
    await t.clock.advance(PONG_TIMEOUT_MS);
    expect(t.sockets[0]!.closed).toBe(false);
  });

  it('applies live messages, unread counts and batches delivery receipts', async () => {
    const t = setup();
    t.server.addConversation('c1');
    await t.engine.start();
    await t.online();
    t.socket().receive({ type: 'message', message: t.server.post('c1', MAYA, 'one') });
    t.socket().receive({ type: 'message', message: t.server.post('c1', MAYA, 'two') });
    expect(bodies(t.engine, 'c1')).toEqual(['one', 'two']);
    expect(t.engine.getSnapshot().conversations[0]).toMatchObject({ unreadCount: 2, lastSeq: 2 });
    await t.clock.advance(500);
    expect(t.server.state.receipts).toEqual([
      { id: 'c1', body: { delivered: 2, shareRead: true } },
    ]);
  });

  it('marks conversations read and honours the read-receipts setting', async () => {
    const t = setup({ readReceipts: false });
    t.server.addConversation('c1');
    t.server.post('c1', MAYA, 'hi');
    await t.engine.start();
    await t.online();
    await t.clock.advance(500);
    t.server.state.receipts = [];
    t.engine.markRead('c1');
    expect(t.engine.getSnapshot().conversations[0]!.unreadCount).toBe(0);
    await t.clock.advance(500);
    expect(t.server.state.receipts).toEqual([
      { id: 'c1', body: { read: 1, delivered: 1, shareRead: false } },
    ]);
  });

  it('applies receipts from other members', async () => {
    const t = setup();
    t.server.addConversation('c1');
    await t.engine.start();
    await t.online();
    t.socket().receive({
      type: 'receipt',
      conversationId: 'c1',
      userId: MAYA,
      deliveredSeq: 3,
      readSeq: 2,
    });
    const maya = t.engine.getSnapshot().conversations[0]!.members.find((m) => m.userId === MAYA);
    expect(maya).toMatchObject({ lastDeliveredSeq: 3, lastReadSeq: 2 });
  });

  it('shows typing for a few seconds and throttles its own typing events', async () => {
    const t = setup();
    t.server.addConversation('c1');
    await t.engine.start();
    await t.online();
    t.socket().receive({ type: 'typing', conversationId: 'c1', userId: MAYA });
    expect(t.engine.getSnapshot().typing.c1).toEqual([MAYA]);
    await t.clock.advance(TYPING_TTL_MS);
    expect(t.engine.getSnapshot().typing.c1).toBeUndefined();

    t.engine.typing('c1');
    t.engine.typing('c1');
    await t.clock.advance(TYPING_THROTTLE_MS);
    t.engine.typing('c1');
    expect(t.socket().sent.filter((s) => s.includes('typing'))).toHaveLength(2);
  });

  it('sends no typing events when typing indicators are off', async () => {
    const t = setup({ typingIndicators: false });
    await t.engine.start();
    await t.online();
    t.engine.typing('c1');
    expect(t.socket().sent.filter((s) => s.includes('typing'))).toHaveLength(0);
  });

  it('only fetches what it missed after a reconnect', async () => {
    const t = setup();
    t.server.addConversation('c1');
    t.server.post('c1', MAYA, 'old');
    await t.engine.start();
    await t.online();
    t.socket().close();
    t.server.post('c1', MAYA, 'missed while offline');
    const spy = jest.spyOn(t.server.api, 'messages');
    await t.clock.advance(1000);
    t.socket().open();
    await flush();
    expect(spy).toHaveBeenCalledWith('c1', { changedSince: 1, limit: 50 });
    expect(bodies(t.engine, 'c1')).toEqual(['old', 'missed while offline']);
  });

  it('loads older history page by page', async () => {
    const t = setup();
    t.server.addConversation('c1');
    for (let i = 1; i <= 60; i++) t.server.post('c1', MAYA, `m${i}`);
    await t.engine.start();
    await t.online();
    expect(t.engine.getSnapshot().messages.c1).toHaveLength(50);
    expect(t.engine.getSnapshot().hasMore.c1).toBe(true);
    await t.engine.loadOlder('c1');
    expect(t.engine.getSnapshot().messages.c1).toHaveLength(60);
    expect(t.engine.getSnapshot().messages.c1![0]!.body).toBe('m1');
    expect(t.engine.getSnapshot().hasMore.c1).toBe(false);
  });

  it('syncs a conversation it hears about for the first time', async () => {
    const t = setup();
    await t.engine.start();
    await t.online();
    t.server.addConversation('c2');
    t.socket().receive({ type: 'conversation', conversationId: 'c2' });
    await flush();
    expect(t.engine.getSnapshot().conversations.map((c) => c.id)).toEqual(['c2']);
  });

  it('stops and reports when the account is signed out', async () => {
    const t = setup();
    t.server.api.getAccessToken = async () => {
      throw new Error('signed out');
    };
    await t.engine.start();
    await flush();
    expect(t.onSignedOut).toHaveBeenCalled();
    expect(t.clock.pending()).toEqual([]);
  });

  it('restores cached conversations and messages before going online', async () => {
    const t = setup();
    t.server.addConversation('c1');
    await t.engine.start();
    await t.online();
    t.engine.send('c1', 'cached');
    await flush();
    t.engine.stop();

    const again = new MessagingEngine({
      me: ME,
      api: { ...t.server.api, getAccessToken: () => new Promise(() => {}) }, // never connects
      connect: () => new FakeSocket('x'),
      store: t.store,
      uuid: () => 'x',
      prefs: () => ({ readReceipts: true, typingIndicators: true }),
      timers: t.clock,
    });
    await again.start();
    expect(bodies(again, 'c1')).toEqual(['cached']);
  });
});

describe('MessagingEngine — edits, files and groups', () => {
  it('catches up on reactions and deletions it missed, not just new messages', async () => {
    const t = setup();
    t.server.addConversation('c1');
    const first = t.server.post('c1', MAYA, 'first');
    t.server.post('c1', MAYA, 'second');
    await t.engine.start();
    await t.online();
    t.socket().close();
    t.server.edit('c1', first.id, { reactions: [{ userId: MAYA, emoji: '❤️' }] });
    t.server.edit('c1', first.id, { body: '', deletedAt: 5 });
    t.server.post('c1', MAYA, 'third');
    await t.clock.advance(1000);
    t.socket().open();
    await flush();
    const list = t.engine.getSnapshot().messages.c1!;
    expect(list.map((m) => [m.body, m.deletedAt])).toEqual([
      ['', 5],
      ['second', null],
      ['third', null],
    ]);
  });

  it('skips changes to old messages it hasn’t loaded (no gaps in history)', async () => {
    const t = setup();
    t.server.addConversation('c1');
    const msgs = Array.from({ length: 60 }, (_, i) => t.server.post('c1', MAYA, `m${i + 1}`));
    await t.engine.start();
    await t.online(); // newest 50: m11…m60
    t.socket().close();
    t.server.edit('c1', msgs[0]!.id, { reactions: [{ userId: MAYA, emoji: '👍' }] }); // m1, not loaded
    t.server.edit('c1', msgs[59]!.id, { reactions: [{ userId: MAYA, emoji: '👍' }] }); // m60
    await t.clock.advance(1000);
    t.socket().open();
    await flush();
    const list = t.engine.getSnapshot().messages.c1!;
    expect(list).toHaveLength(50);
    expect(list.at(-1)!.reactions).toHaveLength(1);
    await t.engine.loadOlder('c1');
    expect(t.engine.getSnapshot().messages.c1![0]!.body).toBe('m1');
  });

  const photo = {
    uri: 'file:///outbox/p.jpg',
    posterUri: null,
    request: {
      kind: 'image' as const,
      mimeType: 'image/jpeg' as const,
      sizeBytes: 10,
      width: 4,
      height: 3,
    },
  };

  it('uploads a file, then sends it, reporting progress', async () => {
    const t = setup();
    const uploaded = jest.fn();
    t.server.addConversation('c1');
    await t.engine.start();
    await t.online();
    const local = t.engine.send('c1', 'look', null, photo);
    expect(t.engine.getSnapshot().messages.c1![0]).toMatchObject({
      kind: 'attachment',
      state: 'pending',
    });
    await flush();
    expect(t.server.state.uploads).toEqual([{ id: 'att-1', part: 'content', uri: photo.uri }]);
    const sent = t.engine.getSnapshot().messages.c1![0]!;
    expect(sent).toMatchObject({
      id: local.id,
      state: 'sent',
      body: 'look',
      attachment: { id: 'att-1' },
    });
    expect(t.engine.getSnapshot().progress).toEqual({});
    expect(uploaded).not.toHaveBeenCalled(); // (not wired in this setup)
  });

  it('resumes an interrupted upload without creating it twice', async () => {
    const t = setup();
    t.server.addConversation('c1');
    await t.engine.start();
    await t.online();
    t.server.state.failUpload = new ApiClientError('network', 'offline');
    t.engine.send('c1', '', null, {
      ...photo,
      posterUri: 'file:///outbox/poster.jpg',
      request: { ...photo.request },
    });
    await flush();
    const pending = t.engine.getSnapshot().messages.c1![0]!;
    expect(pending.state).toBe('pending');
    expect(pending.upload).toMatchObject({ attachmentId: 'att-1', uploaded: false });
    // Persisted, so a restart would resume from here too.
    expect(t.store.dump().messages[0]!.upload?.attachmentId).toBe('att-1');

    t.server.state.failUpload = null;
    await t.engine.flushOutbox();
    expect(t.server.state.attachments.size).toBe(1);
    expect(t.engine.getSnapshot().messages.c1![0]!.state).toBe('sent');
  });

  it('starts an expired upload again', async () => {
    const t = setup();
    t.server.addConversation('c1');
    await t.engine.start();
    await t.online();
    t.server.state.failUpload = new ApiClientError('network', 'offline');
    t.engine.send('c1', '', null, photo);
    await flush();
    t.server.state.failUpload = null;
    t.server.state.expireUploads = true; // the server cleaned it up meanwhile
    await t.engine.flushOutbox();
    expect(t.server.state.attachments.size).toBe(2);
    expect(t.engine.getSnapshot().messages.c1![0]).toMatchObject({
      state: 'sent',
      attachment: { id: 'att-2' },
    });
  });

  it('marks a refused file as failed and can discard it', async () => {
    const t = setup();
    t.server.addConversation('c1');
    await t.engine.start();
    await t.online();
    t.server.state.failUpload = new ApiClientError('bad_request', 'File is too large', 400);
    const m = t.engine.send('c1', '', null, photo);
    await flush();
    expect(t.engine.getSnapshot().messages.c1![0]!.state).toBe('failed');
    t.engine.discard(m.id);
    expect(t.engine.getSnapshot().messages.c1).toEqual([]);
    expect(t.store.dump().messages).toEqual([]);
  });

  it('shows my reaction at once and keeps the server’s copy', async () => {
    const t = setup();
    t.server.addConversation('c1');
    const m = t.server.post('c1', MAYA, 'hi');
    await t.engine.start();
    await t.online();
    const pending = t.engine.react('c1', m.id, '👍');
    expect(t.engine.getSnapshot().messages.c1![0]!.reactions).toEqual([
      { userId: ME, emoji: '👍' },
    ]);
    await pending;
    expect(t.engine.getSnapshot().messages.c1![0]!.rev).toBe(2);

    t.server.state.online = false;
    await expect(t.engine.react('c1', m.id, '❤️')).rejects.toThrow();
    expect(t.engine.getSnapshot().messages.c1![0]!.reactions).toEqual([
      { userId: ME, emoji: '👍' },
    ]);
  });

  it('deletes for everyone and ignores stale copies arriving later', async () => {
    const t = setup();
    t.server.addConversation('c1');
    await t.engine.start();
    await t.online();
    t.engine.send('c1', 'oops');
    await flush();
    const sent = t.engine.getSnapshot().messages.c1![0]!;
    await t.engine.deleteForEveryone('c1', sent.id);
    expect(t.engine.getSnapshot().messages.c1![0]).toMatchObject({ body: '', deletedAt: 1 });
    // A late socket echo of the original must not bring the text back.
    t.socket().receive({
      type: 'message',
      message: { ...t.server.state.messages.get('c1')![0], body: 'oops', deletedAt: null, rev: 1 },
    });
    expect(t.engine.getSnapshot().messages.c1![0]!.body).toBe('');
  });

  it('forgets a conversation when I leave or am removed', async () => {
    const t = setup();
    t.server.addConversation('c1');
    t.server.addConversation('c2');
    t.server.post('c1', MAYA, 'hi');
    await t.engine.start();
    await t.online();
    await t.engine.removeMember('c1', ME);
    expect(t.engine.getSnapshot().conversations.map((c) => c.id)).toEqual(['c2']);
    expect(t.engine.getSnapshot().messages.c1).toBeUndefined();

    // Removed by someone else: the server says "conversation" and then 404s.
    t.server.api.conversation = async () => {
      throw new ApiClientError('not_found', 'Conversation not found', 404);
    };
    t.socket().receive({ type: 'conversation', conversationId: 'c2' });
    await flush();
    expect(t.engine.getSnapshot().conversations).toEqual([]);
  });

  it('doesn’t count group changes as unread', async () => {
    const t = setup();
    t.server.addConversation('c1');
    await t.engine.start();
    await t.online();
    const base = t.server.post('c1', MAYA, 'x');
    t.socket().receive({ type: 'message', message: base });
    t.socket().receive({
      type: 'message',
      message: {
        ...base,
        id: 'sys',
        seq: 2,
        rev: 2,
        kind: 'system',
        body: '',
        system: { action: 'renamed', actorId: MAYA, targetIds: [], title: 'New' },
      },
    });
    expect(t.engine.getSnapshot().conversations[0]!.unreadCount).toBe(1);
  });
});
