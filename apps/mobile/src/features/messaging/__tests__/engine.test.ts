import type {
  ConversationSummary,
  Message,
  OutgoingEnvelope,
  StoredAttachment,
} from '@koode/shared';
import { ApiClientError } from '@/lib/api';
import {
  HEARTBEAT_MS,
  MessagingEngine,
  PONG_TIMEOUT_MS,
  TYPING_THROTTLE_MS,
  TYPING_TTL_MS,
  type MessageCrypto,
  type MessagingApi,
  type SocketLike,
} from '../engine';
import { memoryStore, type MessagingStore } from '../types';

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

/**
 * Stand-in encryption: an envelope is "enc:<plaintext>" for one device. The
 * engine never looks inside envelopes; real libsignal is tested on devices.
 */
const seal = (plain: string) => `enc:${plain}`;
const payload = (m: { id: string; conversationId: string }, rest: Record<string, unknown>) =>
  JSON.stringify({ v: 1, id: m.id, conversationId: m.conversationId, ...rest });

function fakeServer() {
  const state = {
    online: true,
    conversations: new Map<string, ConversationSummary>(),
    /** All envelopes per message (the server keeps one per device). */
    messages: new Map<string, (Message & { all: OutgoingEnvelope[] })[]>(),
    /** Each person's devices with keys. */
    devices: new Map<string, number[]>([
      [ME, [1]],
      [MAYA, [1]],
    ]),
    receipts: [] as { id: string; body: unknown }[],
    /** What Maya's device 1 would read from each send. */
    sends: [] as string[],
    sendKinds: [] as string[],
    rejectSend: null as ApiClientError | null,
    attachments: new Map<string, StoredAttachment>(),
    attachmentRequests: [] as unknown[],
    uploads: [] as { id: string; part: string; uri: string; mimeType: string }[],
    failUpload: null as ApiClientError | null,
    expireUploads: false,
  };
  const ensureOnline = () => {
    if (!state.online) throw new ApiClientError('network', 'offline');
  };
  const addConversation = (id: string, members = [ME, MAYA]) => {
    state.conversations.set(id, {
      id,
      kind: members.length > 2 ? 'group' : 'direct',
      title: null,
      createdAt: 1,
      lastSeq: 0,
      lastRev: 0,
      lastMessage: null,
      unreadCount: 0,
      members: members.map((userId) => ({
        userId,
        role: 'member' as const,
        lastDeliveredSeq: 0,
        lastReadSeq: 0,
      })),
    });
    state.messages.set(id, []);
  };
  /** As this device (ME, 1) receives it: only its own envelope. */
  const view = (m: Message & { all: OutgoingEnvelope[] }): Message => {
    const { all, ...rest } = m;
    return {
      ...rest,
      envelopes: all
        .filter((e) => e.userId === ME && e.deviceId === 1)
        .map(({ deviceId, type, body }) => ({ deviceId, type, body })),
    };
  };
  const store = (
    conversationId: string,
    m: Omit<Message, 'seq' | 'rev' | 'createdAt' | 'envelopes'> & { all: OutgoingEnvelope[] },
  ) => {
    const list = state.messages.get(conversationId)!;
    const existing = list.find((x) => x.id === m.id);
    if (existing) return view(existing);
    const c = state.conversations.get(conversationId)!;
    const msg = {
      ...m,
      seq: c.lastSeq + 1,
      rev: c.lastRev + 1,
      createdAt: 2_000_000 + c.lastSeq,
      envelopes: [],
    };
    list.push(msg);
    state.conversations.set(conversationId, {
      ...c,
      lastSeq: msg.seq,
      lastRev: msg.rev,
      lastMessage: m.kind === 'reaction' ? c.lastMessage : view(msg),
    });
    return view(msg);
  };
  const base = {
    encryption: 'signal' as const,
    senderDevice: 1,
    body: '',
    replyToId: null,
    attachment: null,
    system: null,
    targetId: null,
    deletedAt: null,
  };
  /** A message from someone else, encrypted to my device. */
  const post = (
    conversationId: string,
    senderId: string,
    text: string,
    opts: { id?: string; plain?: string; envelope?: boolean } = {},
  ) => {
    const id = opts.id ?? `00000000-0000-4000-8000-${String(Math.random()).slice(2, 14)}`;
    const plain =
      opts.plain ?? payload({ id, conversationId }, { t: 'text', body: text, replyToId: null });
    return store(conversationId, {
      ...base,
      id,
      conversationId,
      senderId,
      kind: 'text',
      all: opts.envelope === false ? [] : [{ userId: ME, deviceId: 1, type: 3, body: seal(plain) }],
    });
  };
  /** Someone's reaction ('' removes). */
  const react = (
    conversationId: string,
    senderId: string,
    targetId: string,
    emoji: string | null,
  ) => {
    const id = `00000000-0000-4000-8000-${String(Math.random()).slice(2, 14)}`;
    const plain = payload({ id, conversationId }, { t: 'reaction', targetId, emoji });
    return store(conversationId, {
      ...base,
      id,
      conversationId,
      senderId,
      kind: 'reaction',
      targetId,
      all: [{ userId: ME, deviceId: 1, type: 2, body: seal(plain) }],
    });
  };
  /** Change an existing message on the server (new revision). */
  const edit = (conversationId: string, id: string, patch: Partial<Message>) => {
    const c = state.conversations.get(conversationId)!;
    const list = state.messages.get(conversationId)!;
    const i = list.findIndex((m) => m.id === id);
    const next = { ...list[i]!, ...patch, rev: c.lastRev + 1 };
    if (next.deletedAt !== null) next.all = [];
    list[i] = next;
    state.conversations.set(conversationId, { ...c, lastRev: next.rev });
    return view(next);
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
      const all = state.messages.get(id)!.map(view);
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
      // Exactly the current devices of the members, except mine (1).
      const members = state.conversations.get(id)!.members.map((m) => m.userId);
      const want = members.flatMap((u) =>
        (state.devices.get(u) ?? []).filter((d) => !(u === ME && d === 1)).map((d) => `${u}.${d}`),
      );
      const got = body.envelopes.map((e) => `${e.userId}.${e.deviceId}`);
      const missing = want.filter((k) => !got.includes(k));
      const extra = got.filter((k) => !want.includes(k));
      const split = (k: string) => ({
        userId: k.split('.')[0]!,
        deviceId: Number(k.split('.')[1]),
      });
      if (missing.length || extra.length)
        throw new ApiClientError('conflict', 'Devices changed', 409, {
          missing: missing.map(split),
          extra: extra.map(split),
        });
      const toMaya = body.envelopes.find((e) => e.userId === MAYA && e.deviceId === 1);
      if (toMaya) {
        const p = JSON.parse(toMaya.body.slice(4));
        state.sends.push(p.t === 'reaction' ? (p.emoji ?? '') : p.body);
      }
      state.sendKinds.push(body.kind);
      return store(id, {
        ...base,
        id: body.id,
        conversationId: id,
        senderId: ME,
        kind: body.kind,
        attachment: body.attachmentId ? state.attachments.get(body.attachmentId)! : null,
        targetId: body.targetId ?? null,
        all: body.envelopes,
      });
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
      state.attachmentRequests.push(body);
      const meta: StoredAttachment = {
        id: `att-${state.attachments.size + 1}`,
        kind: 'encrypted',
        mimeType: 'application/octet-stream',
        sizeBytes: body.sizeBytes,
        name: null,
        width: null,
        height: null,
        durationMs: null,
        waveform: null,
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
      state.uploads.push({ id: attachmentId, part, uri: file.uri, mimeType: file.mimeType });
      if (part === 'thumbnail')
        state.attachments.set(attachmentId, {
          ...state.attachments.get(attachmentId)!,
          hasThumbnail: true,
        });
      onProgress(1);
    },
    deleteMessage: async (id, messageId) => {
      ensureOnline();
      return edit(id, messageId, { deletedAt: 1, attachment: null });
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
  return { state, api, addConversation, post, react, edit };
}

/** Device crypto stand-in: knows devices as the server last told it (refresh reloads). */
function fakeCrypto(server: ReturnType<typeof fakeServer>) {
  const known = new Map<string, number[]>();
  const calls = { decrypt: 0, refresh: 0, identityChanged: false };
  const crypto: MessageCrypto = {
    deviceId: async () => 1,
    encrypt: async (userIds, plain) => {
      if (calls.identityChanged) {
        const e = new Error('Safety number changed');
        e.name = 'IdentityChangedError';
        throw e;
      }
      return userIds.flatMap((u) => {
        if (!known.has(u)) known.set(u, [...(server.state.devices.get(u) ?? [])]);
        return known
          .get(u)!
          .filter((d) => !(u === ME && d === 1))
          .map((d) => ({ userId: u, deviceId: d, type: 2 as const, body: seal(plain) }));
      });
    },
    decrypt: async (_sender, _device, envelope) => {
      calls.decrypt++;
      if (!envelope.body.startsWith('enc:')) throw new Error('Bad MAC');
      return envelope.body.slice(4);
    },
    refresh: async (mismatch, userIds = []) => {
      calls.refresh++;
      for (const u of [...userIds, ...(mismatch?.missing ?? []).map((d) => d.userId)])
        known.delete(u);
    },
  };
  return { crypto, calls };
}

function setup(
  opts: {
    readReceipts?: boolean;
    typingIndicators?: boolean;
    seedRandom?: number;
    store?: MessagingStore;
    server?: ReturnType<typeof fakeServer>;
  } = {},
) {
  const clock = fakeClock();
  const server = opts.server ?? fakeServer();
  const { crypto, calls } = fakeCrypto(server);
  const store = (opts.store ?? memoryStore()) as ReturnType<typeof memoryStore>;
  const sockets: FakeSocket[] = [];
  const onSignedOut = jest.fn();
  let n = 0;
  const engine = new MessagingEngine({
    me: ME,
    api: server.api,
    crypto,
    sealFile: async (uri) => ({ uri: `${uri}.sealed`, key: 'a2V5', digest: 'ZGlnZXN0', size: 38 }),
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
  return { clock, server, store, engine, sockets, socket, online, onSignedOut, crypto, calls };
}

/** What's shown in a conversation (reactions are messages too, but not shown). */
const shown = (engine: MessagingEngine, id: string) =>
  (engine.getSnapshot().messages[id] ?? []).filter((m) => m.kind !== 'reaction');
const bodies = (engine: MessagingEngine, id: string) => shown(engine, id).map((m) => m.body);

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
    const { all: _all, ...echo } = t.server.state.messages.get('c1')![0]!;
    t.socket().receive({ type: 'message', message: echo });
    await flush();
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
    await flush();
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

  it('learns the name of someone new in a conversation', async () => {
    const t = setup();
    const users = jest.spyOn(t.server.api, 'users');
    await t.engine.start();
    await t.online();
    const before = users.mock.calls.length;
    t.server.addConversation('c3', [ME, 'usr_new']);
    t.socket().receive({ type: 'conversation', conversationId: 'c3' });
    await flush();
    expect(users.mock.calls.length).toBeGreaterThan(before);
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
      crypto: t.crypto,
      sealFile: async () => {
        throw new Error('unused');
      },
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
    t.server.react('c1', MAYA, first.id, '❤️');
    t.server.edit('c1', first.id, { deletedAt: 5 });
    t.server.post('c1', MAYA, 'third');
    await t.clock.advance(1000);
    t.socket().open();
    await flush();
    const list = shown(t.engine, 'c1');
    expect(list[0]!.reactions).toEqual([]); // reactions go with the message
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
    t.server.react('c1', MAYA, msgs[0]!.id, '👍'); // m1, not loaded
    t.server.react('c1', MAYA, msgs[59]!.id, '👍'); // m60
    await t.clock.advance(1000);
    t.socket().open();
    await flush();
    const list = shown(t.engine, 'c1');
    expect(list).toHaveLength(50);
    expect(list.at(-1)!.reactions).toHaveLength(1);
    await t.engine.loadOlder('c1');
    const m1 = shown(t.engine, 'c1')[0]!;
    expect(m1.body).toBe('m1');
    expect(m1.reactions).toEqual([{ userId: MAYA, emoji: '👍' }]); // applied once it loaded
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
    // Only ciphertext goes up; the server learns its size and nothing else.
    expect(t.server.state.attachmentRequests).toEqual([{ sizeBytes: 38 }]);
    expect(t.server.state.uploads).toEqual([
      {
        id: 'att-1',
        part: 'content',
        uri: `${photo.uri}.sealed`,
        mimeType: 'application/octet-stream',
      },
    ]);
    const sent = t.engine.getSnapshot().messages.c1![0]!;
    expect(sent).toMatchObject({
      id: local.id,
      state: 'sent',
      body: 'look',
      attachment: {
        id: 'att-1',
        kind: 'image',
        width: 4,
        height: 3,
        secret: { content: { key: 'a2V5', digest: 'ZGlnZXN0' }, thumbnail: null },
      },
    });
    // What the description of the file looks like is in Maya's envelope.
    expect(t.server.state.sends).toEqual(['look']);
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

  it('reacts with an encrypted message, shown at once and withdrawn if it can’t be sent', async () => {
    const t = setup();
    t.server.addConversation('c1');
    const m = t.server.post('c1', MAYA, 'hi');
    await t.engine.start();
    await t.online();
    const pending = t.engine.react('c1', m.id, '👍');
    expect(shown(t.engine, 'c1')[0]!.reactions).toEqual([{ userId: ME, emoji: '👍' }]);
    await pending;
    expect(t.server.state.sendKinds).toEqual(['reaction']);
    expect(t.server.state.sends).toEqual(['👍']);

    t.server.state.online = false;
    await expect(t.engine.react('c1', m.id, '❤️')).rejects.toThrow();
    expect(shown(t.engine, 'c1')[0]!.reactions).toEqual([{ userId: ME, emoji: '👍' }]);
    t.server.state.online = true;
    await t.engine.react('c1', m.id, null);
    expect(shown(t.engine, 'c1')[0]!.reactions).toEqual([]);
  });

  it('counts each person’s latest reaction', async () => {
    const t = setup();
    t.server.addConversation('c1');
    const m = t.server.post('c1', MAYA, 'hi');
    await t.engine.start();
    await t.online();
    for (const emoji of ['👍', '😂']) {
      t.socket().receive({ type: 'message', message: t.server.react('c1', MAYA, m.id, emoji) });
      await flush();
    }
    expect(shown(t.engine, 'c1')[0]!.reactions).toEqual([{ userId: MAYA, emoji: '😂' }]);
    t.socket().receive({ type: 'message', message: t.server.react('c1', MAYA, m.id, null) });
    await flush();
    expect(shown(t.engine, 'c1')[0]!.reactions).toEqual([]);
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
    const { all: _all, ...original } = t.server.state.messages.get('c1')![0]!;
    t.socket().receive({ type: 'message', message: { ...original, deletedAt: null, rev: 1 } });
    await flush();
    expect(t.engine.getSnapshot().messages.c1![0]).toMatchObject({ body: '', deletedAt: 1 });
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
    await flush();
    t.socket().receive({
      type: 'message',
      message: {
        ...base,
        id: 'sys',
        seq: 2,
        rev: 2,
        kind: 'system',
        encryption: 'none',
        senderDevice: null,
        envelopes: [],
        system: { action: 'renamed', actorId: MAYA, targetIds: [], title: 'New' },
      },
    });
    await flush();
    expect(t.engine.getSnapshot().conversations[0]!.unreadCount).toBe(1);
  });
});

describe('MessagingEngine — end-to-end encryption', () => {
  it('decrypts each message once, even when it arrives twice', async () => {
    const t = setup();
    t.server.addConversation('c1');
    await t.engine.start();
    await t.online();
    const m = t.server.post('c1', MAYA, 'once');
    t.socket().receive({ type: 'message', message: m });
    await t.engine.sync(); // the same message in a catch-up page
    t.socket().receive({ type: 'message', message: m });
    await flush();
    expect(bodies(t.engine, 'c1')).toEqual(['once']);
    expect(t.calls.decrypt).toBe(1);
  });

  it('uses the decrypted copy it cached instead of decrypting again', async () => {
    const t = setup();
    t.server.addConversation('c1');
    for (let i = 1; i <= 3; i++) t.server.post('c1', MAYA, `m${i}`);
    await t.engine.start();
    await t.online();
    expect(t.calls.decrypt).toBe(3);
    t.engine.stop();
    // Restarted with nothing in memory: the copies are only in the cache.
    const again = setup({
      server: t.server,
      store: { ...t.store, load: async () => ({ conversations: [], messages: [], users: [] }) },
    });
    await again.engine.start();
    await again.online();
    expect(bodies(again.engine, 'c1')).toEqual(['m1', 'm2', 'm3']);
    expect(again.calls.decrypt).toBe(0);
  });

  it('re-encrypts for the right devices when the server says they changed', async () => {
    const t = setup();
    t.server.addConversation('c1');
    await t.engine.start();
    await t.online();
    t.engine.send('c1', 'first');
    await flush();
    t.server.state.devices.set(MAYA, [1, 2]); // Maya signed in on an iPad
    t.server.state.devices.set(ME, [1, 3]); // and so did I
    t.engine.send('c1', 'second');
    await flush();
    expect(t.calls.refresh).toBe(1);
    expect(shown(t.engine, 'c1').map((m) => m.state)).toEqual(['sent', 'sent']);
    const last = t.server.state.messages.get('c1')!.at(-1)!;
    expect(last.all.map((e) => `${e.userId}.${e.deviceId}`).sort()).toEqual([
      `${MAYA}.1`,
      `${MAYA}.2`,
      `${ME}.3`,
    ]);
  });

  it('fails a send when a safety number changed, without retrying', async () => {
    const t = setup();
    t.server.addConversation('c1');
    await t.engine.start();
    await t.online();
    t.calls.identityChanged = true;
    t.engine.send('c1', 'hello?');
    await flush();
    expect(shown(t.engine, 'c1')[0]!.state).toBe('failed');
    expect(t.server.state.sends).toEqual([]);
  });

  it('marks messages it can’t read, without trusting misplaced content', async () => {
    const t = setup();
    t.server.addConversation('c1');
    t.server.addConversation('c2');
    t.server.post('c1', MAYA, 'garbled', { plain: 'not json' });
    // A valid payload, but for another conversation: the server moved it.
    t.server.post('c1', MAYA, 'moved', {
      id: '00000000-0000-4000-8000-00000000abcd',
      plain: payload(
        { id: '00000000-0000-4000-8000-00000000abcd', conversationId: 'c2' },
        { t: 'text', body: 'moved', replyToId: null },
      ),
    });
    t.server.post('c1', MAYA, 'not for this device', { envelope: false });
    await t.engine.start();
    await t.online();
    expect(shown(t.engine, 'c1').map((m) => [m.body, m.undecryptable])).toEqual([
      ['', 'failed'],
      ['', 'failed'],
      ['', 'missing'],
    ]);
  });

  it('keeps showing pre-encryption messages as they were', async () => {
    const t = setup();
    t.server.addConversation('c1');
    const m = t.server.post('c1', MAYA, 'x');
    t.server.edit('c1', m.id, { encryption: 'none', body: 'from before Phase 8' });
    await t.engine.start();
    await t.online();
    expect(bodies(t.engine, 'c1')).toEqual(['from before Phase 8']);
    expect(t.calls.decrypt).toBe(0);
  });
});

describe('MessagingEngine — lazy history', () => {
  /** A cache that, like SQLite, loads only the newest few messages per chat at start-up. */
  const lazy = (store: ReturnType<typeof memoryStore>, perChat: number): MessagingStore => ({
    ...store,
    load: async () => {
      const all = await store.load();
      const byChat = new Map<string, typeof all.messages>();
      for (const m of all.messages)
        byChat.set(m.conversationId, [...(byChat.get(m.conversationId) ?? []), m]);
      return {
        ...all,
        messages: [...byChat.values()].flatMap((l) =>
          l.sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0)).slice(0, perChat),
        ),
      };
    },
  });

  it('scrolls back through cached history without the network', async () => {
    const t = setup();
    t.server.addConversation('c1');
    for (let i = 1; i <= 30; i++) t.server.post('c1', MAYA, `m${i}`);
    await t.engine.start();
    await t.online();
    t.engine.stop();
    const again = setup({ server: t.server, store: lazy(t.store, 10) });
    t.server.state.online = false;
    await again.engine.start();
    expect(bodies(again.engine, 'c1')).toHaveLength(10);
    const fetch = jest.spyOn(t.server.api, 'messages');
    await again.engine.loadOlder('c1');
    expect(bodies(again.engine, 'c1')).toHaveLength(30);
    expect(fetch).not.toHaveBeenCalled();
    expect(again.calls.decrypt).toBe(0);
  });

  it('keeps reactions on messages that are only in the cache', async () => {
    const t = setup();
    t.server.addConversation('c1');
    const first = t.server.post('c1', MAYA, 'old one');
    for (let i = 1; i <= 20; i++) t.server.post('c1', MAYA, `m${i}`);
    await t.engine.start();
    await t.online();
    t.engine.stop();

    // Restarted with only the newest 5 loaded; a reaction to the old message arrives.
    const again = setup({ server: t.server, store: lazy(t.store, 5) });
    await again.engine.start();
    await again.online();
    again
      .socket()
      .receive({ type: 'message', message: t.server.react('c1', MAYA, first.id, '🎉') });
    await flush();
    const cached = (await t.store.getMessages([first.id]))[0]!;
    expect(cached.reactions).toEqual([{ userId: MAYA, emoji: '🎉' }]);
    // Scrolling back shows it, even though the reaction message itself isn't reloaded.
    again.engine.stop();
    const third = setup({ server: t.server, store: lazy(t.store, 5) });
    await third.engine.start();
    await third.engine.loadOlder('c1');
    await third.engine.loadOlder('c1');
    await third.engine.loadOlder('c1');
    expect(shown(third.engine, 'c1').find((m) => m.id === first.id)?.reactions).toEqual([
      { userId: MAYA, emoji: '🎉' },
    ]);
  });

  it('puts back my previous reaction if a new one can’t be sent', async () => {
    const t = setup();
    t.server.addConversation('c1');
    const m = t.server.post('c1', MAYA, 'hi');
    await t.engine.start();
    await t.online();
    await t.engine.react('c1', m.id, '👍');
    t.server.state.online = false;
    await expect(t.engine.react('c1', m.id, '😂')).rejects.toThrow();
    expect(shown(t.engine, 'c1')[0]!.reactions).toEqual([{ userId: ME, emoji: '👍' }]);
  });
});

describe('MessagingEngine — background', () => {
  it('suspends without timers or reconnects, and catches up on resume', async () => {
    const t = setup();
    t.server.addConversation('c1');
    await t.engine.start();
    await t.online();
    t.engine.suspend();
    expect(t.socket().closed).toBe(true);
    expect(t.engine.getSnapshot().connection).toBe('offline');
    expect(t.clock.pending()).toEqual([]); // no heartbeat, no reconnect: the radio can sleep
    await t.clock.advance(60_000);
    expect(t.sockets).toHaveLength(1);

    t.server.post('c1', MAYA, 'while you were away');
    t.engine.resume();
    await flush();
    t.socket().open();
    await flush();
    expect(t.sockets).toHaveLength(2);
    expect(bodies(t.engine, 'c1')).toEqual(['while you were away']);
  });
});
