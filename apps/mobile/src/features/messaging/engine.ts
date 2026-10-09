import {
  ServerEvent,
  type AttachmentMeta,
  type Call,
  type ConversationSummary,
  type CreateAttachmentRequest,
  type CreateConversationRequest,
  type Message,
  type MessagePage,
  type PublicUser,
  type ReceiptRequest,
} from '@koode/shared';
import { ApiClientError } from '@/lib/api';
import {
  normalizeMessage,
  type LocalMessage,
  type LocalUpload,
  type MessagingStore,
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
  send: (
    id: string,
    body: { id: string; body: string; replyToId?: string | null; attachmentId?: string | null },
  ) => Promise<Message>;
  receipts: (id: string, body: ReceiptRequest) => Promise<unknown>;
  createConversation: (body: CreateConversationRequest) => Promise<ConversationSummary>;
  createAttachment: (
    conversationId: string,
    body: CreateAttachmentRequest,
  ) => Promise<AttachmentMeta>;
  /** PUT a local file as the attachment's content or (video) poster. */
  upload: (
    attachmentId: string,
    part: 'content' | 'thumbnail',
    file: { uri: string; mimeType: string },
    onProgress: (fraction: number) => void,
  ) => Promise<void>;
  react: (conversationId: string, messageId: string, emoji: string | null) => Promise<Message>;
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

export type EngineDeps = {
  me: string;
  api: MessagingApi;
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
  onUploaded?: (upload: LocalUpload, attachment: AttachmentMeta) => void;
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

const fromServer = (m: Message): LocalMessage => ({ ...m, state: 'sent' });

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
      case 'message':
        this.ingest([fromServer(event.message)]);
        if (!this.findConversation(event.message.conversationId))
          void this.syncConversation(event.message.conversationId);
        else this.bumpConversation(event.message);
        if (event.message.senderId !== this.deps.me)
          this.queueAck(event.message.conversationId, { delivered: event.message.seq });
        this.clearTyping(event.message.conversationId, event.message.senderId);
        break;
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
      list = await this.deps.api.conversations();
    } catch {
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
        this.ingest(page.messages.map(fromServer));
        this.emit({ hasMore: { ...this.snapshot.hasMore, [c.id]: page.hasMore } });
      } else {
        let since = local.reduce((m, x) => Math.max(m, x.rev ?? 0), 0);
        if (c.lastRev <= since) return;
        const known = new Set(local.map((m) => m.id));
        const oldest = local.reduce((m, x) => Math.min(m, x.seq!), Number.MAX_SAFE_INTEGER);
        for (let i = 0; i < SYNC_PAGES_PER_CONVERSATION; i++) {
          const page = await this.deps.api.messages(c.id, { changedSince: since, limit: PAGE });
          this.ingest(
            page.messages.filter((m) => known.has(m.id) || m.seq >= oldest).map(fromServer),
          );
          since = page.messages.at(-1)?.rev ?? since;
          if (!page.hasMore) break;
        }
      }
      const received = (this.snapshot.messages[c.id] ?? []).filter(
        (m) => m.senderId !== this.deps.me && m.seq,
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
      this.ingest(page.messages.map(fromServer));
      this.emit({ hasMore: { ...this.snapshot.hasMore, [conversationId]: page.hasMore } });
    } catch {
      // offline: try again on next scroll
    }
  }

  // ——— Local state updates ———

  private findConversation(id: string) {
    return this.snapshot.conversations.find((c) => c.id === id);
  }

  private async upsertConversation(summary: ConversationSummary) {
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
    const changed: LocalMessage[] = [];
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
      changed.push(m);
    }
    for (const id of new Set(changed.map((m) => m.conversationId)))
      messages[id] = [...messages[id]!].sort(bySeq);
    void this.cache((st) => st.saveMessages(changed));
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
          .filter((m) => m.state === 'pending')
          .sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!next) break;
        try {
          const upload = next.upload ? await this.uploadFor(next) : null;
          const saved = await this.deps.api.send(next.conversationId, {
            id: next.id,
            body: next.body,
            replyToId: next.replyToId,
            attachmentId: upload?.attachmentId ?? null,
          });
          this.ingest([fromServer(saved)]);
          this.bumpConversation(saved);
          this.setProgress(next.id, null);
          if (upload && saved.attachment) this.deps.onUploaded?.(upload, saved.attachment);
        } catch (e) {
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
   * Create → (poster) → content, skipping steps already done. An expired
   * upload (unsent for a day; the server cleans those up) starts again.
   */
  private async uploadFor(m: LocalMessage): Promise<LocalUpload> {
    let upload = this.current(m).upload!;
    for (let attempt = 0; ; attempt++) {
      try {
        if (!upload.attachmentId) {
          const meta = await this.deps.api.createAttachment(m.conversationId, upload.request);
          upload = { ...upload, attachmentId: meta.id, posterUploaded: false, uploaded: false };
          this.saveUpload(m, upload);
        }
        if (upload.posterUri && !upload.posterUploaded) {
          await this.deps.api.upload(
            upload.attachmentId!,
            'thumbnail',
            { uri: upload.posterUri, mimeType: 'image/jpeg' },
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
            { uri: upload.uri, mimeType: upload.request.mimeType },
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

  /** Set or (null) remove my reaction; shown at once, reverted if the server refuses. */
  async react(conversationId: string, messageId: string, emoji: string | null): Promise<void> {
    const before = (this.snapshot.messages[conversationId] ?? []).find((m) => m.id === messageId);
    if (!before || before.seq === null) return;
    const others = before.reactions.filter((r) => r.userId !== this.deps.me);
    this.replaceLocal({
      ...before,
      reactions: emoji ? [...others, { userId: this.deps.me, emoji }] : others,
    });
    try {
      this.ingest([fromServer(await this.deps.api.react(conversationId, messageId, emoji))]);
    } catch (e) {
      this.replaceLocal(before);
      throw e;
    }
  }

  /** Delete for everyone (my message, or as a group admin). */
  async deleteForEveryone(conversationId: string, messageId: string): Promise<void> {
    const saved = await this.deps.api.deleteMessage(conversationId, messageId);
    this.ingest([fromServer(saved)]);
    this.bumpConversation(saved);
  }

  /** Optimistic local edit that ignores revision ordering (reverted on failure). */
  private replaceLocal(m: LocalMessage) {
    const list = this.snapshot.messages[m.conversationId] ?? [];
    this.emit({
      messages: {
        ...this.snapshot.messages,
        [m.conversationId]: list.map((x) => (x.id === m.id ? m : x)),
      },
    });
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

function sortConversations(list: ConversationSummary[]): ConversationSummary[] {
  const activity = (c: ConversationSummary) => c.lastMessage?.createdAt ?? c.createdAt;
  return [...list].sort((a, b) => activity(b) - activity(a));
}
