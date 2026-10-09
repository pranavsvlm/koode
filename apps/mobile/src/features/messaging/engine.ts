import {
  DeviceMismatch,
  Payload,
  ServerEvent,
  type Call,
  type ConversationSummary,
  type CreateConversationRequest,
  type CreateEncryptedAttachmentRequest,
  type DeviceMismatch as Mismatch,
  type Envelope,
  type Message,
  type MessagePage,
  type OutgoingEnvelope,
  type PublicUser,
  type ReceiptRequest,
  type SendMessageRequest,
  type StoredAttachment,
} from '@koode/shared';
import { ApiClientError } from '@/lib/api';
import {
  normalizeMessage,
  type LocalAttachment,
  type LocalMessage,
  type LocalUpload,
  type MessagingStore,
  type SealedFile,
  type Snapshot,
} from './types';

/** Server API surface the engine needs (authenticated). */
export type MessagingApi = {
  getAccessToken: () => Promise<string>;
  users: () => Promise<PublicUser[]>;
  conversations: () => Promise<ConversationSummary[]>;
  conversation: (id: string) => Promise<ConversationSummary>;
  messages: (
    id: string,
    cursor: { before?: number; after?: number; changedSince?: number; limit?: number },
  ) => Promise<MessagePage>;
  send: (id: string, body: SendMessageRequest) => Promise<Message>;
  receipts: (id: string, body: ReceiptRequest) => Promise<unknown>;
  createConversation: (body: CreateConversationRequest) => Promise<ConversationSummary>;
  createAttachment: (
    conversationId: string,
    body: CreateEncryptedAttachmentRequest,
  ) => Promise<StoredAttachment>;
  /** PUT a local file as the attachment's content or (video) poster. */
  upload: (
    attachmentId: string,
    part: 'content' | 'thumbnail',
    file: { uri: string; mimeType: string },
    onProgress: (fraction: number) => void,
  ) => Promise<void>;
  deleteMessage: (conversationId: string, messageId: string) => Promise<Message>;
  renameGroup: (conversationId: string, title: string) => Promise<ConversationSummary>;
  addMembers: (conversationId: string, userIds: string[]) => Promise<ConversationSummary>;
  setRole: (
    conversationId: string,
    userId: string,
    role: 'member' | 'admin',
  ) => Promise<ConversationSummary>;
  removeMember: (conversationId: string, userId: string) => Promise<unknown>;
};

/** Minimal socket surface (React Native WebSocket in the app, a fake in tests). */
export type SocketLike = {
  send: (data: string) => void;
  close: () => void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: ((code: number) => void) | null;
};

/** End-to-end encryption for messages (libsignal in the app, a fake in tests). */
export type MessageCrypto = {
  /** This device's Signal number (its envelope in each message). */
  deviceId: () => Promise<number>;
  /** Encrypt for every device of these people except this one. */
  encrypt: (userIds: string[], plaintext: string) => Promise<OutgoingEnvelope[]>;
  decrypt: (senderId: string, senderDevice: number, envelope: Envelope) => Promise<string>;
  /** Devices changed (a send was refused): reload those people's device lists. */
  refresh: (mismatch: Mismatch | null, userIds?: string[]) => Promise<void>;
};

export type EngineDeps = {
  me: string;
  api: MessagingApi;
  crypto: MessageCrypto;
  /** Encrypt a file for upload (a fresh key per file). */
  sealFile: (uri: string) => Promise<SealedFile>;
  connect: (accessToken: string) => SocketLike;
  store: MessagingStore;
  uuid: () => string;
  /** Read at call time so settings changes apply immediately. */
  prefs: () => { readReceipts: boolean; typingIndicators: boolean };
  /** Called when the account can no longer authenticate. */
  onSignedOut?: () => void;
  /** Call signalling arrives on the same socket; the call controller handles it. */
  onCall?: (call: Call) => void;
  /** A file was sent: the app may keep it as the cached copy of the attachment. */
  onUploaded?: (upload: LocalUpload, attachment: LocalAttachment) => void;
  /** A pending upload was cancelled or failed for good: its outbox files can go. */
  onDiscarded?: (upload: LocalUpload) => void;
  isSignedOutError?: (e: unknown) => boolean;
  now?: () => number;
  random?: () => number;
  timers?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
};

export const HEARTBEAT_MS = 25_000;
export const PONG_TIMEOUT_MS = 10_000;
export const TYPING_TTL_MS = 5_000;
export const TYPING_THROTTLE_MS = 3_000;
export const RECEIPT_DEBOUNCE_MS = 400;
const MAX_BACKOFF_MS = 30_000;
const SYNC_PAGES_PER_CONVERSATION = 10;
const PAGE = 50;
const PING = JSON.stringify({ type: 'ping' });

/** Outbox failures worth retrying later (offline, server hiccup, auth renewal). */
function isTransient(e: unknown): boolean {
  // A changed safety number or lost keys need the user, not a retry.
  if (e instanceof Error && (e.name === 'IdentityChangedError' || e.name === 'KeysLostError'))
    return false;
  if (!(e instanceof ApiClientError)) return true;
  return (
    e.code === 'network' ||
    e.code === 'timeout' ||
    e.code === 'internal' ||
    e.code === 'rate_limited' ||
    e.code === 'unauthorized' ||
    (e.status ?? 0) >= 500
  );
}

const bySeq = (a: LocalMessage, b: LocalMessage) =>
  (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER) ||
  a.createdAt - b.createdAt;

/** The server's view of a message (ordering, deletion), without content. */
const serverFields = (m: Message) => ({
  id: m.id,
  conversationId: m.conversationId,
  seq: m.seq,
  rev: m.rev,
  senderId: m.senderId,
  kind: m.kind,
  system: m.system,
  targetId: m.targetId,
  deletedAt: m.deletedAt,
  createdAt: m.createdAt,
  state: 'sent' as const,
});

/** A plaintext message from before end-to-end encryption, or a system message. */
const plaintext = (m: Message): LocalMessage => ({
  ...serverFields(m),
  body: m.body,
  replyToId: m.replyToId,
  attachment:
    m.attachment && m.attachment.kind !== 'encrypted'
      ? { ...m.attachment, kind: m.attachment.kind }
      : null,
  reactions: [],
});

const MAX_SEND_ATTEMPTS = 3;

/** A 409 telling the sender which devices it missed or shouldn't have addressed. */
function mismatchOf(e: unknown): Mismatch | null {
  if (!(e instanceof ApiClientError) || e.code !== 'conflict') return null;
  const parsed = DeviceMismatch.safeParse(e.details);
  return parsed.success ? parsed.data : null;
}

/** What a send says, inside the envelopes. */
function payloadFor(m: LocalMessage, upload: LocalUpload | null): Payload {
  const bound = { v: 1 as const, id: m.id, conversationId: m.conversationId };
  if (m.kind === 'reaction')
    return { ...bound, t: 'reaction', targetId: m.targetId!, emoji: m.body || null };
  if (!upload) return { ...bound, t: 'text', body: m.body, replyToId: m.replyToId };
  const r = upload.request;
  return {
    ...bound,
    t: 'attachment',
    body: m.body,
    replyToId: m.replyToId,
    attachment: {
      kind: r.kind,
      mimeType: r.mimeType,
      sizeBytes: r.sizeBytes,
      name: r.kind === 'document' ? r.name : null,
      width: r.kind === 'image' || r.kind === 'video' ? r.width : null,
      height: r.kind === 'image' || r.kind === 'video' ? r.height : null,
      durationMs: r.kind === 'video' || r.kind === 'voice' ? r.durationMs : null,
      waveform: r.kind === 'voice' ? r.waveform : null,
      preview: r.kind === 'image' || r.kind === 'video' ? (r.preview ?? null) : null,
      content: { key: upload.sealed!.key, digest: upload.sealed!.digest },
      thumbnail: upload.posterSealed
        ? { key: upload.posterSealed.key, digest: upload.posterSealed.digest }
        : null,
    },
  };
}

/** The attachment as shown, from a decrypted (or just-sent) payload. */
function attachmentFrom(
  p: Extract<Payload, { t: 'attachment' }>,
  stored: StoredAttachment,
): LocalAttachment {
  const a = p.attachment;
  return {
    id: stored.id,
    kind: a.kind,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    name: a.name,
    width: a.width,
    height: a.height,
    durationMs: a.durationMs,
    waveform: a.waveform,
    preview: a.preview,
    hasThumbnail: stored.hasThumbnail && !!a.thumbnail,
    secret: { content: a.content, thumbnail: a.thumbnail },
  };
}

/** Content fields of a message (what decryption or sending provides). */
function contentOf(p: Payload, m: Message): Partial<LocalMessage> | null {
  if (p.t === 'call' || p.id !== m.id || p.conversationId !== m.conversationId) return null;
  if (p.t !== m.kind) return null;
  switch (p.t) {
    case 'text':
      return { body: p.body.trim(), replyToId: p.replyToId, attachment: null };
    case 'attachment':
      if (!m.attachment) return null;
      return {
        body: p.body.trim(),
        replyToId: p.replyToId,
        attachment: attachmentFrom(p, m.attachment),
      };
    case 'reaction':
      if (p.targetId !== m.targetId) return null;
      return { body: p.emoji ?? '', replyToId: null, attachment: null };
  }
}

/** Native module errors wrap the real reason in `cause`. */
function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as Error & { cause?: unknown }).cause;
  return cause ? `${e.message} ← ${describeError(cause)}` : e.message;
}

/**
 * Keeps the local cache in sync with the server over HTTP + WebSocket:
 * live events, catch-up after reconnects, an offline outbox, batched
 * receipts and throttled typing. Framework-agnostic; React subscribes.
 */
export class MessagingEngine {
  private deps: Required<
    Omit<EngineDeps, 'onSignedOut' | 'isSignedOutError' | 'onCall' | 'onUploaded' | 'onDiscarded'>
  > &
    Pick<EngineDeps, 'onSignedOut' | 'isSignedOutError' | 'onCall' | 'onUploaded' | 'onDiscarded'>;
  private snapshot: Snapshot = {
    connection: 'offline',
    conversations: [],
    messages: {},
    users: {},
    typing: {},
    hasMore: {},
    progress: {},
  };
  private listeners = new Set<() => void>();
  private socket: SocketLike | null = null;
  private running = false;
  private attempt = 0;
  private reconnectTimer: unknown = null;
  private heartbeatTimer: unknown = null;
  private pongTimer: unknown = null;
  private flushing: Promise<void> | null = null;
  private flushAgain = false;
  private pendingAcks = new Map<string, { delivered?: number; read?: number }>();
  private ackTimer: unknown = null;
  private lastTypingSent = new Map<string, number>();
  private typingExpiry = new Map<string, Map<string, number>>();
  private typingTimer: unknown = null;
  /** Server messages are opened in arrival order, one batch at a time. */
  private inbox: Promise<unknown> = Promise.resolve();
  private myDevice: number | null = null;

  constructor(deps: EngineDeps) {
    this.deps = {
      now: Date.now,
      random: Math.random,
      timers: {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      },
      ...deps,
    };
  }

  /** Cache writes never throw: the cache is an optimisation, the server is the truth. */
  private cache(op: (store: MessagingStore) => Promise<unknown>): Promise<void> {
    return op(this.deps.store).then(
      () => undefined,
      (e: unknown) => {
        if (__DEV__) console.warn(`[messaging] cache error: ${describeError(e)}`);
      },
    );
  }

  // ——— Subscription ———

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): Snapshot {
    return this.snapshot;
  }

  private emit(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }

  // ——— Lifecycle ———

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // A broken cache must not stop messaging: fall back to server-only.
    const cached = await this.deps.store.load().catch((e: unknown) => {
      if (__DEV__) console.warn(`[messaging] cache load failed: ${describeError(e)}`);
      return { conversations: [], messages: [], users: [] };
    });
    const messages: Record<string, LocalMessage[]> = {};
    for (const raw of cached.messages) {
      const m = normalizeMessage(raw);
      (messages[m.conversationId] ??= []).push(m);
    }
    for (const list of Object.values(messages)) list.sort(bySeq);
    this.emit({
      conversations: sortConversations(cached.conversations),
      messages,
      users: Object.fromEntries(cached.users.map((u) => [u.id, u])),
    });
    void this.refreshUsers();
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearTimer('reconnectTimer');
    this.clearTimer('heartbeatTimer');
    this.clearTimer('pongTimer');
    this.clearTimer('ackTimer');
    this.clearTimer('typingTimer');
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onclose = null;
      s.close();
    }
    this.emit({ connection: 'offline' });
  }

  /** Stop and erase the local cache (sign-out). */
  async reset(): Promise<void> {
    this.stop();
    await this.cache((st) => st.clear());
    this.emit({
      conversations: [],
      messages: {},
      users: {},
      typing: {},
      hasMore: {},
      progress: {},
    });
  }

  /** App returned to the foreground or the network came back. */
  resume(): void {
    if (!this.running) return;
    if (this.snapshot.connection === 'online') {
      void this.sync();
    } else {
      this.attempt = 0;
      this.clearTimer('reconnectTimer');
      this.connect();
    }
  }

  private clearTimer(
    key: 'reconnectTimer' | 'heartbeatTimer' | 'pongTimer' | 'ackTimer' | 'typingTimer',
  ) {
    if (this[key] !== null) this.deps.timers.clearTimeout(this[key]);
    this[key] = null;
  }

  // ——— Connection ———

  private async connect(): Promise<void> {
    if (!this.running || this.socket) return;
    this.emit({ connection: 'connecting' });
    let token: string;
    try {
      token = await this.deps.api.getAccessToken();
    } catch (e) {
      if (this.deps.isSignedOutError?.(e)) {
        this.stop();
        this.deps.onSignedOut?.();
        return;
      }
      this.scheduleReconnect();
      return;
    }
    if (!this.running || this.socket) return;

    const socket = this.deps.connect(token);
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.emit({ connection: 'online' });
      this.heartbeat();
      void this.sync().then(() => this.flushOutbox());
    };
    socket.onmessage = (data) => this.onSocketMessage(data);
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimer('heartbeatTimer');
      this.clearTimer('pongTimer');
      this.emit({ connection: 'offline' });
      this.scheduleReconnect();
    };
  }

  /** Exponential backoff with jitter: ~1s, 2s, 4s … capped at 30s. */
  private scheduleReconnect() {
    if (!this.running || this.reconnectTimer !== null) return;
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempt);
    const delay = Math.round(base * (0.5 + this.deps.random() * 0.5));
    this.attempt += 1;
    this.emit({ connection: 'offline' });
    this.reconnectTimer = this.deps.timers.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  /** A connection that silently died (e.g. network switch) is detected by a missed pong. */
  private heartbeat() {
    this.clearTimer('heartbeatTimer');
    this.heartbeatTimer = this.deps.timers.setTimeout(() => {
      this.heartbeatTimer = null;
      const s = this.socket;
      if (!s) return;
      try {
        s.send(PING);
      } catch {
        // send failure surfaces as close
      }
      this.pongTimer = this.deps.timers.setTimeout(() => {
        this.pongTimer = null;
        if (this.socket === s) s.close(); // triggers reconnect via onclose
      }, PONG_TIMEOUT_MS);
    }, HEARTBEAT_MS);
  }

  private onSocketMessage(data: string) {
    // Any traffic proves the connection is alive.
    this.clearTimer('pongTimer');
    if (!this.heartbeatTimer) this.heartbeat();
    let event: ServerEvent;
    try {
      const parsed = ServerEvent.safeParse(JSON.parse(data));
      if (!parsed.success) return;
      event = parsed.data;
    } catch {
      return;
    }
    switch (event.type) {
      case 'message': {
        const m = event.message;
        void this.receive([m]).then(
          () => {
            if (!this.findConversation(m.conversationId))
              void this.syncConversation(m.conversationId);
            else this.bumpConversation(m);
            if (m.senderId !== this.deps.me && m.kind !== 'reaction')
              this.queueAck(m.conversationId, { delivered: m.seq });
          },
          // Couldn't get ready to decrypt (offline): catch-up fetches it again.
          () => undefined,
        );
        this.clearTyping(m.conversationId, m.senderId);
        break;
      }
      case 'receipt':
        this.applyReceipt(event.conversationId, event.userId, event.deliveredSeq, event.readSeq);
        break;
      case 'typing':
        if (event.userId !== this.deps.me) this.setTyping(event.conversationId, event.userId);
        break;
      case 'conversation':
        void this.syncConversation(event.conversationId);
        break;
      case 'call':
        this.deps.onCall?.(event.call);
        break;
      default:
        break;
    }
  }

  // ——— Sync ———

  private async refreshUsers() {
    try {
      const users = await this.deps.api.users();
      await this.cache((st) => st.saveUsers(users));
      this.emit({ users: Object.fromEntries(users.map((u) => [u.id, u])) });
    } catch {
      // offline: keep cached directory
    }
  }

  /** Catch up after (re)connecting: conversation list, then missing messages. */
  async sync(): Promise<void> {
    let list: ConversationSummary[];
    try {
      // Keys must be ready before messages can be opened (publishes them on first run).
      await this.ensureDevice();
      list = await this.deps.api.conversations();
    } catch (e) {
      if (__DEV__) console.warn(`[messaging] sync failed: ${describeError(e)}`);
      return;
    }
    await this.cache((st) => st.saveConversations(list));
    this.emit({ conversations: sortConversations(list) });
    void this.refreshUsers();
    await Promise.all(list.map((c) => this.catchUp(c)));
  }

  private async syncConversation(id: string) {
    try {
      const summary = await this.deps.api.conversation(id);
      await this.upsertConversation(summary);
      await this.catchUp(summary);
    } catch (e) {
      // Left or removed from a group: it's no longer ours to show.
      if (e instanceof ApiClientError && e.code === 'not_found') await this.forgetConversation(id);
      // otherwise: try again on next sync
    }
  }

  private async forgetConversation(id: string) {
    await this.cache((st) => st.removeConversation(id));
    const { [id]: _gone, ...messages } = this.snapshot.messages;
    this.emit({
      conversations: this.snapshot.conversations.filter((c) => c.id !== id),
      messages,
    });
  }

  /**
   * Bring a conversation up to date: new messages *and* changes to ones we
   * have (reactions, deletions), by revision. Changes to older messages that
   * aren't loaded are skipped; they arrive current when scrolled to.
   */
  private async catchUp(c: ConversationSummary) {
    const local = (this.snapshot.messages[c.id] ?? []).filter((m) => m.seq !== null);
    try {
      if (local.length === 0) {
        if (c.lastSeq === 0) return;
        // New to this device: fetch the newest page; older history loads on scroll.
        const page = await this.deps.api.messages(c.id, { limit: PAGE });
        await this.receive(page.messages);
        this.emit({ hasMore: { ...this.snapshot.hasMore, [c.id]: page.hasMore } });
      } else {
        let since = local.reduce((m, x) => Math.max(m, x.rev ?? 0), 0);
        if (c.lastRev <= since) return;
        const known = new Set(local.map((m) => m.id));
        const oldest = local.reduce((m, x) => Math.min(m, x.seq!), Number.MAX_SAFE_INTEGER);
        for (let i = 0; i < SYNC_PAGES_PER_CONVERSATION; i++) {
          const page = await this.deps.api.messages(c.id, { changedSince: since, limit: PAGE });
          await this.receive(page.messages.filter((m) => known.has(m.id) || m.seq >= oldest));
          since = page.messages.at(-1)?.rev ?? since;
          if (!page.hasMore) break;
        }
      }
      const received = (this.snapshot.messages[c.id] ?? []).filter(
        (m) => m.senderId !== this.deps.me && m.seq && m.kind !== 'reaction',
      );
      const top = received.reduce((m, x) => Math.max(m, x.seq ?? 0), 0);
      if (top > 0) this.queueAck(c.id, { delivered: top });
    } catch {
      // partial catch-up is fine; the next sync continues from the new revision
    }
  }

  /** Older history for a conversation (scrolling up). */
  async loadOlder(conversationId: string): Promise<void> {
    if (this.snapshot.hasMore[conversationId] === false) return;
    const local = this.snapshot.messages[conversationId] ?? [];
    const minSeq = local.reduce(
      (m, x) => (x.seq !== null ? Math.min(m, x.seq) : m),
      Number.MAX_SAFE_INTEGER,
    );
    try {
      const page = await this.deps.api.messages(conversationId, {
        before: minSeq === Number.MAX_SAFE_INTEGER ? undefined : minSeq,
        limit: PAGE,
      });
      await this.receive(page.messages);
      this.emit({ hasMore: { ...this.snapshot.hasMore, [conversationId]: page.hasMore } });
    } catch {
      // offline: try again on next scroll
    }
  }

  // ——— Opening (decrypting) messages ———

  private async ensureDevice(): Promise<number> {
    this.myDevice ??= await this.deps.crypto.deviceId();
    return this.myDevice;
  }

  /**
   * Open server messages and merge them in. Batches run one after another in
   * arrival order (the same message may come over the socket and in a
   * catch-up page; it's decrypted once). Rejects only if this device isn't
   * ready to decrypt (offline at start-up); nothing is merged then.
   */
  private receive(messages: Message[]): Promise<void> {
    const run = this.inbox.then(async () => {
      if (messages.length === 0) return;
      await this.ensureDevice();
      const cached = new Map(
        (
          await this.deps.store
            .getMessages(messages.filter((m) => !this.findLocal(m)).map((m) => m.id))
            .catch(() => [])
        ).map((m) => [m.id, normalizeMessage(m)]),
      );
      const opened: LocalMessage[] = [];
      for (const m of messages)
        opened.push(await this.open(m, this.findLocal(m) ?? cached.get(m.id)));
      this.ingest(opened);
    });
    this.inbox = run.catch(() => undefined);
    return run;
  }

  private findLocal(m: { id: string; conversationId: string }): LocalMessage | undefined {
    return (this.snapshot.messages[m.conversationId] ?? []).find((x) => x.id === m.id);
  }

  /** A server message → the local copy, decrypting it if this device hasn't yet. */
  private async open(m: Message, local: LocalMessage | undefined): Promise<LocalMessage> {
    if (m.encryption === 'none') return plaintext(m);
    const keep = local ? { reactions: local.reactions, upload: undefined } : { reactions: [] };
    if (m.deletedAt !== null) {
      return {
        ...(local ?? { reactions: [] }),
        ...serverFields(m),
        body: '',
        replyToId: null,
        attachment: null,
        reactions: [],
        upload: undefined,
        opened: true,
        undecryptable: null,
      };
    }
    // Still in this device's outbox: the send's own response completes it.
    if (local && local.state !== 'sent') return local;
    // Already readable here (sent from this device, or decrypted before).
    if (local?.opened) {
      return {
        ...local,
        ...serverFields(m),
        ...keep,
        attachment: local.attachment && {
          ...local.attachment,
          id: m.attachment?.id ?? local.attachment.id,
          hasThumbnail:
            (m.attachment?.hasThumbnail ?? false) && !!local.attachment.secret?.thumbnail,
        },
      };
    }
    if (local?.undecryptable) return { ...local, ...serverFields(m), ...keep };

    const base: LocalMessage = {
      ...serverFields(m),
      body: '',
      replyToId: null,
      attachment: null,
      ...keep,
    };
    const device = this.myDevice!;
    const envelope = m.envelopes.find((e) => e.deviceId === device);
    if (!envelope || m.senderDevice === null) return { ...base, undecryptable: 'missing' };
    try {
      const text = await this.deps.crypto.decrypt(m.senderId, m.senderDevice, envelope);
      const payload = Payload.safeParse(JSON.parse(text));
      const content = payload.success ? contentOf(payload.data, m) : null;
      // Wrong shape, or names another message / chat: the server moved it.
      if (!content) return { ...base, undecryptable: 'failed' };
      return { ...base, ...content, opened: true, undecryptable: null };
    } catch (e) {
      if (__DEV__) console.warn(`[messaging] couldn't decrypt ${m.id}: ${describeError(e)}`);
      const identity = /identity/i.test(describeError(e));
      return { ...base, undecryptable: identity ? 'identity' : 'failed' };
    }
  }

  // ——— Local state updates ———

  private findConversation(id: string) {
    return this.snapshot.conversations.find((c) => c.id === id);
  }

  private async upsertConversation(summary: ConversationSummary) {
    // Someone new (just joined Koode, or added to a group): learn their name.
    if (summary.members.some((m) => !this.snapshot.users[m.userId] && m.userId !== this.deps.me))
      void this.refreshUsers();
    await this.cache((st) => st.saveConversations([summary]));
    const others = this.snapshot.conversations.filter((c) => c.id !== summary.id);
    this.emit({ conversations: sortConversations([...others, summary]) });
  }

  private patchConversation(id: string, patch: (c: ConversationSummary) => ConversationSummary) {
    const current = this.findConversation(id);
    if (!current) return;
    const next = patch(current);
    void this.cache((st) => st.saveConversations([next]));
    this.emit({
      conversations: sortConversations(
        this.snapshot.conversations.map((c) => (c.id === id ? next : c)),
      ),
    });
  }

  private bumpConversation(m: Message) {
    if (m.kind === 'reaction') return; // not activity
    this.patchConversation(m.conversationId, (c) => ({
      ...c,
      lastSeq: Math.max(c.lastSeq, m.seq),
      lastMessage: !c.lastMessage || m.seq >= c.lastMessage.seq ? m : c.lastMessage,
      lastRev: Math.max(c.lastRev ?? 0, m.rev),
      unreadCount:
        m.senderId === this.deps.me || m.kind === 'system'
          ? c.unreadCount
          : c.unreadCount + (m.seq > c.lastSeq ? 1 : 0),
    }));
  }

  /** Merge messages (dedupe by id; server copies replace pending ones). */
  private ingest(incoming: LocalMessage[]) {
    if (incoming.length === 0) return;
    const messages = { ...this.snapshot.messages };
    const changed = new Map<string, LocalMessage>();
    for (const m of incoming) {
      const list = messages[m.conversationId] ?? [];
      const i = list.findIndex((x) => x.id === m.id);
      if (i >= 0) {
        const current = list[i]!;
        if (current.state === 'sent' && m.state !== 'sent') continue; // never downgrade
        if (current.rev !== null && m.rev !== null && m.rev < current.rev) continue; // stale copy
        const next = [...list];
        next[i] = m;
        messages[m.conversationId] = next;
      } else {
        messages[m.conversationId] = [...list, m];
      }
      changed.set(m.id, m);
    }
    for (const id of new Set([...changed.values()].map((m) => m.conversationId))) {
      const touched = new Set(
        [...changed.values()]
          .filter((m) => m.conversationId === id)
          .map((m) => (m.kind === 'reaction' ? m.targetId! : m.id)),
      );
      messages[id] = withReactions([...messages[id]!].sort(bySeq), touched, (m) =>
        changed.set(m.id, m),
      );
    }
    void this.cache((st) => st.saveMessages([...changed.values()]));
    this.emit({ messages });
  }

  private applyReceipt(
    conversationId: string,
    userId: string,
    deliveredSeq: number,
    readSeq: number,
  ) {
    this.patchConversation(conversationId, (c) => ({
      ...c,
      members: c.members.map((m) =>
        m.userId === userId
          ? {
              ...m,
              lastDeliveredSeq: Math.max(m.lastDeliveredSeq, deliveredSeq),
              lastReadSeq: Math.max(m.lastReadSeq, readSeq),
            }
          : m,
      ),
      // My own read position moving (another of my devices) clears unread here too.
      ...(userId === this.deps.me ? { unreadCount: readSeq >= c.lastSeq ? 0 : c.unreadCount } : {}),
    }));
  }

  // ——— Typing ———

  private setTyping(conversationId: string, userId: string) {
    const map = this.typingExpiry.get(conversationId) ?? new Map<string, number>();
    map.set(userId, this.deps.now() + TYPING_TTL_MS);
    this.typingExpiry.set(conversationId, map);
    this.publishTyping();
  }

  private clearTyping(conversationId: string, userId: string) {
    if (this.typingExpiry.get(conversationId)?.delete(userId)) this.publishTyping();
  }

  private publishTyping() {
    const now = this.deps.now();
    const typing: Record<string, string[]> = {};
    let nextExpiry = Infinity;
    for (const [conv, users] of this.typingExpiry) {
      for (const [user, exp] of users) {
        if (exp <= now) users.delete(user);
        else nextExpiry = Math.min(nextExpiry, exp);
      }
      if (users.size) typing[conv] = [...users.keys()];
    }
    this.emit({ typing });
    this.clearTimer('typingTimer');
    if (nextExpiry !== Infinity) {
      this.typingTimer = this.deps.timers.setTimeout(() => {
        this.typingTimer = null;
        this.publishTyping();
      }, nextExpiry - now);
    }
  }

  /** Call while the user types; sends at most one event per few seconds. */
  typing(conversationId: string): void {
    if (
      !this.deps.prefs().typingIndicators ||
      !this.socket ||
      this.snapshot.connection !== 'online'
    )
      return;
    const now = this.deps.now();
    if (now - (this.lastTypingSent.get(conversationId) ?? 0) < TYPING_THROTTLE_MS) return;
    this.lastTypingSent.set(conversationId, now);
    try {
      this.socket.send(JSON.stringify({ type: 'typing', conversationId }));
    } catch {
      // ignore
    }
  }

  // ——— Sending ———

  /** Queue a message; it is shown immediately and delivered when possible. */
  send(
    conversationId: string,
    body: string,
    replyToId: string | null = null,
    upload?: Omit<LocalUpload, 'attachmentId' | 'posterUploaded' | 'uploaded'>,
  ): LocalMessage {
    const message: LocalMessage = normalizeMessage({
      id: this.deps.uuid(),
      conversationId,
      seq: null,
      senderId: this.deps.me,
      kind: upload ? 'attachment' : 'text',
      body: body.trim(),
      replyToId,
      createdAt: this.deps.now(),
      state: 'pending',
      opened: true,
      upload: upload && { ...upload, attachmentId: null, posterUploaded: false, uploaded: false },
    });
    this.ingest([message]);
    this.lastTypingSent.delete(conversationId);
    void this.flushOutbox();
    return message;
  }

  retry(messageId: string): void {
    const m = Object.values(this.snapshot.messages)
      .flat()
      .find((x) => x.id === messageId);
    if (!m || m.state !== 'failed') return;
    this.ingest([{ ...m, state: 'pending' }]);
    void this.flushOutbox();
  }

  /**
   * Deliver pending messages in order. Serialized so retries can't race; a
   * call made while a flush is finishing schedules another pass, so nothing
   * queued in that window waits for the next reconnect.
   */
  flushOutbox(): Promise<void> {
    this.flushAgain = true;
    if (this.flushing) return this.flushing;
    // Cleared via .finally() (which runs after this assignment), not inside the
    // async body: with an empty outbox the body finishes synchronously.
    this.flushing = this.drainOutbox().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async drainOutbox(): Promise<void> {
    while (this.flushAgain) {
      this.flushAgain = false;
      for (;;) {
        const next = Object.values(this.snapshot.messages)
          .flat()
          .filter((m) => m.state === 'pending' && m.kind !== 'reaction')
          .sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!next) break;
        try {
          const upload = next.upload ? await this.uploadFor(next) : null;
          const { saved, sent } = await this.deliver(next, upload);
          this.ingest([sent]);
          this.bumpConversation(saved);
          this.setProgress(next.id, null);
          if (upload && sent.attachment) this.deps.onUploaded?.(upload, sent.attachment);
        } catch (e) {
          if (__DEV__) console.warn(`[messaging] send failed: ${describeError(e)}`);
          if (isTransient(e)) {
            this.flushAgain = false;
            return; // stays pending; retried on reconnect/resume
          }
          this.setProgress(next.id, null);
          this.ingest([{ ...this.current(next), state: 'failed' }]);
        }
      }
    }
  }

  /** Members to encrypt for (fetching the conversation if it isn't known yet). */
  private async membersOf(conversationId: string, fresh = false): Promise<string[]> {
    let c = fresh ? undefined : this.findConversation(conversationId);
    if (!c) {
      c = await this.deps.api.conversation(conversationId);
      await this.upsertConversation(c);
    }
    return c.members.map((m) => m.userId);
  }

  /**
   * Encrypt for every current device of every member and send. If devices
   * changed (someone added a phone, left the group …), the server says which
   * and the message is encrypted again for the right set.
   */
  private async deliver(
    m: LocalMessage,
    upload: LocalUpload | null,
  ): Promise<{ saved: Message; sent: LocalMessage }> {
    const payload = payloadFor(m, upload);
    const plain = JSON.stringify(payload);
    let fresh = false;
    for (let attempt = 1; ; attempt++) {
      const members = await this.membersOf(m.conversationId, fresh);
      const envelopes = await this.deps.crypto.encrypt(members, plain);
      try {
        const saved = await this.deps.api.send(m.conversationId, {
          id: m.id,
          kind: m.kind === 'reaction' ? 'reaction' : upload ? 'attachment' : 'text',
          envelopes,
          attachmentId: upload?.attachmentId ?? null,
          targetId: m.targetId ?? null,
        });
        const content = contentOf(payload, saved);
        return {
          saved,
          sent: {
            ...m,
            ...serverFields(saved),
            ...content,
            upload: undefined,
            opened: true,
            undecryptable: null,
          },
        };
      } catch (e) {
        const mismatch = mismatchOf(e);
        if (!mismatch || attempt >= MAX_SEND_ATTEMPTS) throw e;
        await this.deps.crypto.refresh(mismatch, members);
        fresh = true; // membership may have changed too
      }
    }
  }

  private current(m: LocalMessage): LocalMessage {
    return (this.snapshot.messages[m.conversationId] ?? []).find((x) => x.id === m.id) ?? m;
  }

  private setProgress(messageId: string, fraction: number | null) {
    const { [messageId]: _old, ...rest } = this.snapshot.progress;
    this.emit({ progress: fraction === null ? rest : { ...rest, [messageId]: fraction } });
  }

  /** Remember an upload step on the pending message (persisted, so retries resume). */
  private saveUpload(m: LocalMessage, upload: LocalUpload) {
    this.ingest([{ ...this.current(m), upload }]);
  }

  /**
   * Encrypt → create → (poster) → content, skipping steps already done. The
   * server only ever receives ciphertext. An expired upload (unsent for a
   * day; the server cleans those up) starts again from "create".
   */
  private async uploadFor(m: LocalMessage): Promise<LocalUpload> {
    let upload = this.current(m).upload!;
    if (!upload.sealed) {
      upload = { ...upload, sealed: await this.deps.sealFile(upload.uri) };
      this.saveUpload(m, upload);
    }
    if (upload.posterUri && !upload.posterSealed) {
      upload = { ...upload, posterSealed: await this.deps.sealFile(upload.posterUri) };
      this.saveUpload(m, upload);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        if (!upload.attachmentId) {
          const meta = await this.deps.api.createAttachment(m.conversationId, {
            sizeBytes: upload.sealed!.size,
          });
          upload = { ...upload, attachmentId: meta.id, posterUploaded: false, uploaded: false };
          this.saveUpload(m, upload);
        }
        if (upload.posterSealed && !upload.posterUploaded) {
          await this.deps.api.upload(
            upload.attachmentId!,
            'thumbnail',
            { uri: upload.posterSealed.uri, mimeType: 'application/octet-stream' },
            () => {},
          );
          upload = { ...upload, posterUploaded: true };
          this.saveUpload(m, upload);
        }
        if (!upload.uploaded) {
          this.setProgress(m.id, 0);
          await this.deps.api.upload(
            upload.attachmentId!,
            'content',
            { uri: upload.sealed!.uri, mimeType: 'application/octet-stream' },
            (f) => this.setProgress(m.id, f),
          );
          upload = { ...upload, uploaded: true };
          this.saveUpload(m, upload);
        }
        return upload;
      } catch (e) {
        const expired = e instanceof ApiClientError && e.code === 'not_found';
        if (!expired || attempt > 0) throw e;
        upload = { ...upload, attachmentId: null, posterUploaded: false, uploaded: false };
      }
    }
  }

  /** Remove a message that was never sent (or failed) from this device. */
  discard(messageId: string): void {
    const m = Object.values(this.snapshot.messages)
      .flat()
      .find((x) => x.id === messageId);
    if (!m || m.state === 'sent') return;
    const messages = {
      ...this.snapshot.messages,
      [m.conversationId]: (this.snapshot.messages[m.conversationId] ?? []).filter(
        (x) => x.id !== messageId,
      ),
    };
    void this.cache((st) => st.deleteMessages([messageId]));
    this.emit({ messages });
    this.setProgress(messageId, null);
    if (m.upload) this.deps.onDiscarded?.(m.upload);
  }

  // ——— Reactions and deletion (online only) ———

  /**
   * Set or (null) remove my reaction: an encrypted message naming its target.
   * Shown at once; withdrawn if it can't be sent (online only).
   */
  async react(conversationId: string, messageId: string, emoji: string | null): Promise<void> {
    const target = (this.snapshot.messages[conversationId] ?? []).find((m) => m.id === messageId);
    if (!target || target.seq === null) return;
    const reaction = normalizeMessage({
      id: this.deps.uuid(),
      conversationId,
      seq: null,
      senderId: this.deps.me,
      kind: 'reaction',
      body: emoji ?? '',
      targetId: messageId,
      createdAt: this.deps.now(),
      state: 'pending',
      opened: true,
    });
    this.ingest([reaction]);
    try {
      this.ingest([(await this.deliver(reaction, null)).sent]);
    } catch (e) {
      this.drop(reaction);
      throw e;
    }
  }

  /** Remove a local-only message (and recompute what it affected). */
  private drop(m: LocalMessage) {
    const list = (this.snapshot.messages[m.conversationId] ?? []).filter((x) => x.id !== m.id);
    const touched = new Set(m.targetId ? [m.targetId] : []);
    const changed: LocalMessage[] = [];
    this.emit({
      messages: {
        ...this.snapshot.messages,
        [m.conversationId]: withReactions(list, touched, (x) => changed.push(x)),
      },
    });
    void this.cache((st) => st.deleteMessages([m.id]));
    void this.cache((st) => st.saveMessages(changed));
  }

  /** Delete for everyone (my message, or as a group admin). */
  async deleteForEveryone(conversationId: string, messageId: string): Promise<void> {
    const saved = await this.deps.api.deleteMessage(conversationId, messageId);
    await this.receive([saved]);
    this.bumpConversation(saved);
  }

  // ——— Receipts ———

  /** The user is looking at this conversation: mark everything as read. */
  markRead(conversationId: string): void {
    const c = this.findConversation(conversationId);
    if (!c) return;
    const me = c.members.find((m) => m.userId === this.deps.me);
    const top = (this.snapshot.messages[conversationId] ?? []).reduce(
      (m, x) => Math.max(m, x.seq ?? 0),
      0,
    );
    const target = Math.max(top, c.lastSeq);
    if (target === 0 || (me && me.lastReadSeq >= target && c.unreadCount === 0)) return;
    this.patchConversation(conversationId, (conv) => ({
      ...conv,
      unreadCount: 0,
      members: conv.members.map((m) =>
        m.userId === this.deps.me ? { ...m, lastReadSeq: Math.max(m.lastReadSeq, target) } : m,
      ),
    }));
    this.queueAck(conversationId, { read: target, delivered: target });
  }

  private queueAck(conversationId: string, ack: { delivered?: number; read?: number }) {
    const prev = this.pendingAcks.get(conversationId) ?? {};
    this.pendingAcks.set(conversationId, {
      delivered: Math.max(prev.delivered ?? 0, ack.delivered ?? 0) || undefined,
      read: Math.max(prev.read ?? 0, ack.read ?? 0) || undefined,
    });
    if (this.ackTimer === null) {
      this.ackTimer = this.deps.timers.setTimeout(() => {
        this.ackTimer = null;
        void this.flushAcks();
      }, RECEIPT_DEBOUNCE_MS);
    }
  }

  private async flushAcks() {
    const batch = [...this.pendingAcks];
    this.pendingAcks.clear();
    const { readReceipts } = this.deps.prefs();
    await Promise.all(
      batch.map(async ([conversationId, ack]) => {
        try {
          await this.deps.api.receipts(conversationId, { ...ack, shareRead: readReceipts });
        } catch {
          // Re-queue; it will go with the next batch.
          const prev = this.pendingAcks.get(conversationId) ?? {};
          this.pendingAcks.set(conversationId, {
            delivered: Math.max(prev.delivered ?? 0, ack.delivered ?? 0) || undefined,
            read: Math.max(prev.read ?? 0, ack.read ?? 0) || undefined,
          });
        }
      }),
    );
  }

  // ——— Conversations ———

  async createConversation(request: CreateConversationRequest): Promise<string> {
    const summary = await this.deps.api.createConversation(request);
    await this.upsertConversation(summary);
    return summary.id;
  }

  // Group administration: the server adds a system message, which arrives as
  // a normal message event; the returned summary updates members at once.

  async renameGroup(conversationId: string, title: string): Promise<void> {
    await this.upsertConversation(await this.deps.api.renameGroup(conversationId, title));
  }

  async addMembers(conversationId: string, userIds: string[]): Promise<void> {
    await this.upsertConversation(await this.deps.api.addMembers(conversationId, userIds));
  }

  async setRole(conversationId: string, userId: string, role: 'member' | 'admin'): Promise<void> {
    await this.upsertConversation(await this.deps.api.setRole(conversationId, userId, role));
  }

  async removeMember(conversationId: string, userId: string): Promise<void> {
    await this.deps.api.removeMember(conversationId, userId);
    if (userId === this.deps.me) await this.forgetConversation(conversationId);
    else await this.syncConversation(conversationId);
  }
}

/**
 * Recompute `reactions` of the touched messages from the (encrypted)
 * reaction messages: each person's latest one counts; '' means removed.
 */
function withReactions(
  list: LocalMessage[],
  touched: Set<string>,
  onChange: (m: LocalMessage) => void,
): LocalMessage[] {
  const latest = new Map<string, LocalMessage>();
  const order = (m: LocalMessage) => m.seq ?? Number.MAX_SAFE_INTEGER; // pending = newest
  for (const r of list) {
    if (r.kind !== 'reaction' || !r.targetId || !touched.has(r.targetId)) continue;
    if (r.deletedAt !== null || r.undecryptable) continue;
    const key = `${r.targetId} ${r.senderId}`;
    const prev = latest.get(key);
    if (!prev || order(r) >= order(prev)) latest.set(key, r);
  }
  return list.map((m) => {
    if (m.kind === 'reaction' || !touched.has(m.id)) return m;
    const reactions =
      m.deletedAt !== null
        ? []
        : [...latest.values()]
            .filter((r) => r.targetId === m.id && r.body)
            .map((r) => ({ userId: r.senderId, emoji: r.body }));
    if (JSON.stringify(reactions) === JSON.stringify(m.reactions)) return m;
    const next = { ...m, reactions };
    onChange(next);
    return next;
  });
}

function sortConversations(list: ConversationSummary[]): ConversationSummary[] {
  const activity = (c: ConversationSummary) => c.lastMessage?.createdAt ?? c.createdAt;
  return [...list].sort((a, b) => activity(b) - activity(a));
}
