import type {
  AttachmentMeta,
  Call,
  ConversationSummary as ServerConversation,
  Reaction as ServerReaction,
  SystemEvent,
} from '@koode/shared';
import { create } from 'zustand';
import { buildFixtures, CANNED_REPLIES } from '@/dev/fixtures';
import { useDevSettings } from '@/dev/settings';
import {
  ME,
  type Attachment,
  type CallRecord,
  type Contact,
  type Conversation,
  type Message,
  type MessageStatus,
  type Reaction,
} from '@/domain/types';
import { callApi, callController, setCallIdentity } from '@/features/calls';
import { resetDeviceCrypto } from '@/features/crypto';
import { clearMediaFiles } from '@/features/media/files';
import type { UploadDraft } from '@/features/media/process';
import {
  clearMessageCache,
  createMessagingEngine,
  type LocalMessage,
  type MessagingEngine,
  type Snapshot,
} from '@/features/messaging';
import { usePreferences } from './preferences';

/**
 * UI-facing chat state. Two sources:
 *  - live:   the messaging engine (server + SQLite cache). Default.
 *  - sample: in-memory fixtures with simulated replies, for design review
 *            (Settings → Developer → Sample data).
 * Screens only depend on this store's shape. In live mode my own user id is
 * mapped to `ME` at this boundary.
 *
 * Device-only: pin, mute and "delete for me".
 */

/** `upload`: a processed file to send (live); `attachment`: sample data. */
export type Draft = {
  text?: string;
  attachment?: Attachment;
  upload?: UploadDraft;
  replyToId?: string;
};

type Overlay = {
  reactions: Record<string, Reaction[]>;
  deleted: Record<string, true>;
  pinned: Record<string, boolean>;
  muted: Record<string, boolean>;
};

type ChatState = {
  mode: 'live' | 'sample';
  status: 'idle' | 'loading' | 'ready';
  connection: Snapshot['connection'];
  contacts: Record<string, Contact>;
  conversations: Record<string, Conversation>;
  /** Per conversation, oldest → newest. */
  messages: Record<string, Message[]>;
  hasMore: Record<string, boolean>;
  calls: CallRecord[];
  overlay: Overlay;
  /** Start for the signed-in user (`me` = their user id). */
  load: (me?: string) => Promise<void>;
  /** Stop syncing and erase local message data (sign-out). */
  unload: () => Promise<void>;
  /** App came to the foreground / network returned. */
  resume: () => void;
  /** App has been in the background a while: disconnect until `resume`. */
  suspend: () => void;
  send: (conversationId: string, draft: Draft) => void;
  retry: (messageId: string) => void;
  loadOlder: (conversationId: string) => Promise<void>;
  typing: (conversationId: string) => void;
  /** Rejects if the server refused (live). */
  toggleReaction: (conversationId: string, messageId: string, emoji: string) => Promise<void>;
  /** "me": hide on this device (or cancel an unsent message); "everyone": delete for all. */
  deleteMessage: (
    conversationId: string,
    messageId: string,
    scope?: 'me' | 'everyone',
  ) => Promise<void>;
  renameGroup: (conversationId: string, title: string) => Promise<void>;
  addMembers: (conversationId: string, userIds: string[]) => Promise<void>;
  removeMember: (conversationId: string, userId: string) => Promise<void>;
  setAdmin: (conversationId: string, userId: string, admin: boolean) => Promise<void>;
  leaveGroup: (conversationId: string) => Promise<void>;
  markRead: (conversationId: string) => void;
  setPinned: (conversationId: string, pinned: boolean) => void;
  setMuted: (conversationId: string, muted: boolean) => void;
  createConversation: (memberIds: string[], title?: string) => Promise<string>;
  addCall: (call: Omit<CallRecord, 'id'>) => void;
  /** Live mode: reload call history from the server. */
  refreshCalls: () => Promise<void>;
};

let counter = 0;
const localId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++counter}`;

let engine: MessagingEngine | null = null;
let engineMe: string | null = null;
let unsubscribe: (() => void) | null = null;

const EMPTY_OVERLAY: Overlay = { reactions: {}, deleted: {}, pinned: {}, muted: {} };

function updateMessage(
  messages: Record<string, Message[]>,
  conversationId: string,
  messageId: string,
  update: (m: Message) => Message,
): Record<string, Message[]> {
  const list = messages[conversationId];
  if (!list) return messages;
  return { ...messages, [conversationId]: list.map((m) => (m.id === messageId ? update(m) : m)) };
}

// ——— Live mode: engine snapshot → UI shapes ———

/** Sent → delivered → read, from every other member's receipt positions. */
export function messageStatus(
  m: LocalMessage,
  conversation: ServerConversation | undefined,
  me: string,
  showRead: boolean,
): MessageStatus {
  if (m.state === 'pending') return 'sending';
  if (m.state === 'failed') return 'failed';
  const others = conversation?.members.filter((x) => x.userId !== me) ?? [];
  if (others.length === 0 || m.seq === null) return 'sent';
  if (showRead && others.every((o) => o.lastReadSeq >= m.seq!)) return 'read';
  if (others.every((o) => o.lastDeliveredSeq >= m.seq!)) return 'delivered';
  return 'sent';
}

/** One chip per emoji, with who reacted. */
export function groupReactions(list: ServerReaction[], mapId: (id: string) => string): Reaction[] {
  const by = new Map<string, string[]>();
  for (const r of list) by.set(r.emoji, [...(by.get(r.emoji) ?? []), mapId(r.userId)]);
  return [...by].map(([emoji, userIds]) => ({ emoji, userIds }));
}

const quote = (s: string | null) => `“${s ?? ''}”`;
const join = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** "Maya added Dan and Sam". `name(id, atStart)` gives "You"/"you" for me. */
export function systemText(e: SystemEvent, name: (id: string, start: boolean) => string): string {
  const actor = name(e.actorId, true);
  const targets = join(e.targetIds.map((t) => name(t, false)));
  switch (e.action) {
    case 'created':
      return `${actor} created the group ${quote(e.title)}`;
    case 'renamed':
      return `${actor} renamed the group to ${quote(e.title)}`;
    case 'added':
      return `${actor} added ${targets}`;
    case 'removed':
      return `${actor} removed ${targets}`;
    case 'left':
      return `${actor} left`;
    case 'promoted':
      return `${actor} made ${targets} an admin`;
    case 'demoted':
      return `${actor} removed ${targets} as an admin`;
  }
}

/** Server attachment, or the file still being sent. */
export function liveAttachment(m: LocalMessage, progress?: number): Attachment | undefined {
  /** What a server attachment and a pending upload request have in common. */
  type Common = {
    kind: AttachmentMeta['kind'];
    mimeType: string;
    sizeBytes: number;
    name?: string | null;
    width?: number | null;
    height?: number | null;
    durationMs?: number | null;
    waveform?: number[] | null;
    preview?: string | null;
  };
  const meta = (m.attachment ?? m.upload?.request ?? null) as Common | null;
  if (!meta) return undefined;
  const ref = {
    attachmentId: m.attachment?.id,
    mimeType: meta.mimeType,
    localUri: m.attachment ? undefined : m.upload?.uri,
    localPosterUri: m.attachment ? undefined : (m.upload?.posterUri ?? undefined),
    preview: meta.preview ?? null,
    hasPoster: m.attachment?.hasThumbnail ?? false,
    progress: m.state === 'pending' ? progress : undefined,
    secret: m.attachment?.secret,
  };
  switch (meta.kind) {
    case 'image':
      return { kind: 'image', width: meta.width ?? 1, height: meta.height ?? 1, ...ref };
    case 'video':
      return {
        kind: 'video',
        width: meta.width ?? 1,
        height: meta.height ?? 1,
        durationSec: (meta.durationMs ?? 0) / 1000,
        ...ref,
      };
    case 'voice':
      return {
        kind: 'voice',
        durationSec: (meta.durationMs ?? 0) / 1000,
        waveform: meta.waveform ?? [],
        ...ref,
      };
    case 'document':
      return {
        kind: 'document',
        name: meta.name ?? 'File',
        sizeBytes: meta.sizeBytes,
        ...ref,
        mimeType: meta.mimeType,
      };
  }
}

/** UI copies of engine messages, by engine message (engine objects change only when they do). */
const uiMessages = new WeakMap<LocalMessage, { key: string; out: Message }>();
const uiChats = new Map<string, { inputs: unknown[]; out: Message[] }>();
let uiContacts: { users: Snapshot['users']; out: Record<string, Contact> } | null = null;
let uiConversations: Record<string, Conversation> = {};
let uiMessageMap: Record<string, Message[]> = {};
/** The whole record stays the same object when no chat changed. */
function stableMessages(next: Record<string, Message[]>) {
  const keys = Object.keys(next);
  const same =
    keys.length === Object.keys(uiMessageMap).length &&
    keys.every((k) => next[k] === uiMessageMap[k]);
  if (!same) uiMessageMap = next;
  return uiMessageMap;
}

export function deriveLive(snap: Snapshot, me: string, overlay: Overlay, showRead: boolean) {
  const mapId = (id: string) => (id === me ? ME : id);
  let contacts: Record<string, Contact> = {};
  if (uiContacts?.users === snap.users) contacts = uiContacts.out;
  else {
    for (const u of Object.values(snap.users)) {
      contacts[u.id] = {
        id: u.id,
        displayName: u.displayName,
        username: u.username,
        about: u.about || undefined,
      };
    }
    uiContacts = { users: snap.users, out: contacts };
  }
  const conversations: Record<string, Conversation> = {};
  const byId = new Map(snap.conversations.map((c) => [c.id, c]));
  for (const c of snap.conversations) {
    const prev = uiConversations[c.id];
    const next: Conversation = {
      id: c.id,
      kind: c.kind,
      title: c.title ?? undefined,
      memberIds: c.members.map((m) => mapId(m.userId)),
      adminIds: c.members.filter((m) => m.role === 'admin').map((m) => mapId(m.userId)),
      pinned: overlay.pinned[c.id] ?? false,
      muted: overlay.muted[c.id] ?? false,
      unreadCount: c.unreadCount,
      typingUserIds: (snap.typing[c.id] ?? []).filter((u) => u !== me),
      createdAt: c.createdAt,
    };
    // Same content → same object (screens and rows that select it don't re-render).
    conversations[c.id] = prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
  }
  const keys = Object.keys(conversations);
  const reuse =
    keys.length === Object.keys(uiConversations).length &&
    keys.every((k) => conversations[k] === uiConversations[k]);
  const stableConversations = reuse ? uiConversations : conversations;
  uiConversations = stableConversations;
  const name = (id: string, start: boolean) =>
    id === me ? (start ? 'You' : 'you') : (contacts[id]?.displayName ?? 'Someone');
  const messages: Record<string, Message[]> = {};
  for (const [convId, list] of Object.entries(snap.messages)) {
    // Nothing this chat depends on changed (e.g. a typing event): reuse it as is.
    const inputs = [
      list,
      byId.get(convId),
      overlay.deleted,
      snap.progress,
      snap.users,
      me,
      showRead,
    ];
    const memo = uiChats.get(convId);
    if (memo && memo.inputs.every((x, i) => x === inputs[i])) {
      messages[convId] = memo.out;
      continue;
    }
    // Reactions are messages too (encrypted), but show only on their target.
    const next = list
      .filter((m) => m.kind !== 'reaction')
      .map((m) => {
        const deleted = m.deletedAt !== null || overlay.deleted[m.id] === true;
        const status =
          m.senderId === me ? messageStatus(m, byId.get(convId), me, showRead) : 'delivered';
        const progress = snap.progress[m.id];
        const system = m.kind === 'system' && m.system ? systemText(m.system, name) : undefined;
        // Unchanged messages keep their object, so memoized bubbles don't re-render.
        const key = `${me}|${deleted}|${status}|${progress ?? ''}|${system ?? ''}`;
        const hit = uiMessages.get(m);
        if (hit?.key === key) return hit.out;
        const out: Message = {
          id: m.id,
          conversationId: m.conversationId,
          senderId: mapId(m.senderId),
          text: deleted || !m.body ? undefined : m.body,
          attachment: deleted ? undefined : liveAttachment(m, progress),
          createdAt: m.createdAt,
          status,
          replyToId: m.replyToId ?? undefined,
          reactions: deleted ? [] : groupReactions(m.reactions, mapId),
          deleted,
          undecryptable: !deleted && m.undecryptable ? m.undecryptable : undefined,
          system,
        };
        uiMessages.set(m, { key, out });
        return out;
      });
    // …and an unchanged chat keeps its array (list components skip it entirely).
    const prev = memo?.out;
    messages[convId] =
      prev && prev.length === next.length && prev.every((x, i) => x === next[i]) ? prev : next;
    uiChats.set(convId, { inputs, out: messages[convId]! });
  }
  return {
    contacts,
    conversations: stableConversations,
    messages: stableMessages(messages),
    hasMore: snap.hasMore,
    connection: snap.connection,
  };
}

export const useChat = create<ChatState>((set, get) => {
  const refreshLive = () => {
    if (!engine || !engineMe || get().mode !== 'live') return;
    set(
      deriveLive(
        engine.getSnapshot(),
        engineMe,
        get().overlay,
        usePreferences.getState().readReceipts,
      ),
    );
  };
  const setOverlay = (patch: (o: Overlay) => Overlay) => {
    set({ overlay: patch(get().overlay) });
    refreshLive();
  };

  return {
    mode: 'live',
    status: 'idle',
    connection: 'offline',
    contacts: {},
    conversations: {},
    messages: {},
    hasMore: {},
    calls: [],
    overlay: EMPTY_OVERLAY,

    load: async (me) => {
      if (get().status !== 'idle') return;
      set({ status: 'loading' });
      const { sampleData, slowLoading, emptyData } = useDevSettings.getState();

      if (sampleData || !me) {
        if (slowLoading) await new Promise((r) => setTimeout(r, 1500));
        const data = buildFixtures();
        const messages: Record<string, Message[]> = {};
        for (const m of data.messages) (messages[m.conversationId] ??= []).push(m);
        for (const list of Object.values(messages)) list.sort((a, b) => a.createdAt - b.createdAt);
        set({
          mode: 'sample',
          status: 'ready',
          connection: 'online',
          contacts: Object.fromEntries(data.contacts.map((c) => [c.id, c])),
          conversations: emptyData
            ? {}
            : Object.fromEntries(data.conversations.map((c) => [c.id, c])),
          messages: emptyData ? {} : messages,
          calls: emptyData ? [] : data.calls,
        });
        return;
      }

      if (engine && engineMe !== me) {
        unsubscribe?.();
        engine.stop();
        engine = null;
      }
      engineMe = me;
      setCallIdentity(me);
      engine ??= createMessagingEngine(
        me,
        () => void get().unload(),
        (call) => {
          callController.onServerCall(call);
          // Keep the Calls tab current as calls start and finish.
          if (call.state !== 'ringing') void get().refreshCalls();
        },
      );
      unsubscribe?.();
      unsubscribe = engine.subscribe(refreshLive);
      set({ mode: 'live', calls: [] });
      await engine.start();
      void get().refreshCalls();
      if (slowLoading) await new Promise((r) => setTimeout(r, 1500));
      refreshLive();
      set({ status: 'ready' });
    },

    unload: async () => {
      uiChats.clear();
      uiContacts = null;
      uiConversations = {};
      uiMessageMap = {};
      void callController.hangUp();
      setCallIdentity(null);
      unsubscribe?.();
      unsubscribe = null;
      if (engine) await engine.reset();
      else await clearMessageCache().catch(() => {});
      clearMediaFiles();
      // Keys and sessions belong to this sign-in; a new one starts afresh.
      await resetDeviceCrypto().catch(() => {});
      engine = null;
      engineMe = null;
      set({
        status: 'idle',
        contacts: {},
        conversations: {},
        messages: {},
        hasMore: {},
        calls: [],
        overlay: EMPTY_OVERLAY,
      });
    },

    resume: () => engine?.resume(),
    suspend: () => engine?.suspend(),

    send: (conversationId, draft) => {
      if (get().mode === 'live') {
        if (draft.upload || draft.text?.trim())
          engine?.send(conversationId, draft.text ?? '', draft.replyToId ?? null, draft.upload);
        return;
      }
      sampleSend(set, get, conversationId, draft);
    },

    retry: (messageId) => engine?.retry(messageId),
    loadOlder: async (conversationId) => {
      if (get().mode === 'live') await engine?.loadOlder(conversationId);
    },
    typing: (conversationId) => engine?.typing(conversationId),

    toggleReaction: async (conversationId, messageId, emoji) => {
      const apply = (current: Reaction[]) => {
        const mine = current.find((r) => r.userIds.includes(ME));
        // One reaction per person: remove my previous one, then add unless toggling off.
        let reactions = current
          .map((r) => ({ ...r, userIds: r.userIds.filter((u) => u !== ME) }))
          .filter((r) => r.userIds.length > 0);
        if (mine?.emoji !== emoji) {
          const existing = reactions.find((r) => r.emoji === emoji);
          reactions = existing
            ? reactions.map((r) => (r.emoji === emoji ? { ...r, userIds: [...r.userIds, ME] } : r))
            : [...reactions, { emoji, userIds: [ME] }];
        }
        return reactions;
      };
      if (get().mode === 'live') {
        const m = get().messages[conversationId]?.find((x) => x.id === messageId);
        const mine = m?.reactions.find((r) => r.userIds.includes(ME));
        await engine?.react(conversationId, messageId, mine?.emoji === emoji ? null : emoji);
        return;
      }
      set((s) => ({
        messages: updateMessage(s.messages, conversationId, messageId, (m) => ({
          ...m,
          reactions: apply(m.reactions),
        })),
      }));
    },

    deleteMessage: async (conversationId, messageId, scope = 'me') => {
      if (get().mode === 'live') {
        const m = get().messages[conversationId]?.find((x) => x.id === messageId);
        if (m && (m.status === 'sending' || m.status === 'failed')) {
          engine?.discard(messageId); // never sent: just drop it
        } else if (scope === 'everyone') {
          await engine?.deleteForEveryone(conversationId, messageId);
        } else {
          setOverlay((o) => ({ ...o, deleted: { ...o.deleted, [messageId]: true } }));
        }
        return;
      }
      set((s) => ({
        messages: updateMessage(s.messages, conversationId, messageId, (m) => ({
          ...m,
          deleted: true,
          text: undefined,
          attachment: undefined,
          reactions: [],
        })),
      }));
    },

    markRead: (conversationId) => {
      if (get().mode === 'live') {
        engine?.markRead(conversationId);
        return;
      }
      set((s) => {
        const c = s.conversations[conversationId];
        if (!c || c.unreadCount === 0) return s;
        return {
          conversations: { ...s.conversations, [conversationId]: { ...c, unreadCount: 0 } },
        };
      });
    },

    setPinned: (conversationId, pinned) => {
      if (get().mode === 'live')
        return setOverlay((o) => ({ ...o, pinned: { ...o.pinned, [conversationId]: pinned } }));
      set((s) => {
        const c = s.conversations[conversationId];
        return c
          ? { conversations: { ...s.conversations, [conversationId]: { ...c, pinned } } }
          : s;
      });
    },

    setMuted: (conversationId, muted) => {
      if (get().mode === 'live')
        return setOverlay((o) => ({ ...o, muted: { ...o.muted, [conversationId]: muted } }));
      set((s) => {
        const c = s.conversations[conversationId];
        return c ? { conversations: { ...s.conversations, [conversationId]: { ...c, muted } } } : s;
      });
    },

    createConversation: async (memberIds, title) => {
      const others = memberIds.filter((m) => m !== ME);
      if (get().mode === 'live') {
        if (!engine) throw new Error('Not connected');
        return title || others.length > 1
          ? engine.createConversation({ kind: 'group', title: title || 'Group', memberIds: others })
          : engine.createConversation({ kind: 'direct', userId: others[0]! });
      }
      return sampleCreate(set, get, others, title);
    },

    renameGroup: async (conversationId, title) => {
      if (get().mode === 'live') return engine?.renameGroup(conversationId, title);
      set((s) => {
        const c = s.conversations[conversationId];
        return c ? { conversations: { ...s.conversations, [conversationId]: { ...c, title } } } : s;
      });
    },
    addMembers: async (conversationId, userIds) => {
      if (get().mode === 'live') return engine?.addMembers(conversationId, userIds);
    },
    removeMember: async (conversationId, userId) => {
      if (get().mode === 'live') return engine?.removeMember(conversationId, userId);
    },
    setAdmin: async (conversationId, userId, admin) => {
      if (get().mode === 'live')
        return engine?.setRole(conversationId, userId, admin ? 'admin' : 'member');
    },
    leaveGroup: async (conversationId) => {
      if (get().mode === 'live' && engineMe) return engine?.removeMember(conversationId, engineMe);
    },

    addCall: (call) => {
      // Live calls are recorded by the server; only sample mode keeps local history.
      if (get().mode === 'sample')
        set((s) => ({ calls: [{ id: localId('call'), ...call }, ...s.calls] }));
    },

    refreshCalls: async () => {
      if (get().mode !== 'live' || !engineMe) return;
      try {
        const me = engineMe;
        set({ calls: (await callApi.list()).map((c) => toCallRecord(c, me)) });
      } catch {
        // offline: keep what we have
      }
    },
  };
});

// Re-derive ticks when the read-receipts preference changes (reciprocity).
usePreferences.subscribe((p, prev) => {
  if (
    p.readReceipts !== prev.readReceipts &&
    engine &&
    engineMe &&
    useChat.getState().mode === 'live'
  ) {
    useChat.setState(
      deriveLive(engine.getSnapshot(), engineMe, useChat.getState().overlay, p.readReceipts),
    );
  }
});

/** Server call → history row from my point of view. */
export function toCallRecord(c: Call, me: string): CallRecord {
  const outgoing = c.callerId === me;
  const outcome: CallRecord['outcome'] =
    c.state === 'ended' || c.state === 'active'
      ? 'answered'
      : c.state === 'cancelled'
        ? outgoing
          ? 'cancelled'
          : 'missed'
        : c.state === 'ringing'
          ? 'missed'
          : c.state;
  return {
    id: c.id,
    contactId: outgoing ? c.calleeId : c.callerId,
    kind: c.kind,
    direction: outgoing ? 'outgoing' : 'incoming',
    outcome,
    startedAt: c.createdAt,
    durationSec:
      c.answeredAt && c.endedAt ? Math.max(0, Math.round((c.endedAt - c.answeredAt) / 1000)) : 0,
  };
}

// ——— Sample mode (design review only) ———

type SetFn = (partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => void;
type GetFn = () => ChatState;

function sampleSend(set: SetFn, get: GetFn, conversationId: string, draft: Draft) {
  const id = localId('msg');
  const message: Message = {
    id,
    conversationId,
    senderId: ME,
    text: draft.text?.trim() || undefined,
    attachment: draft.attachment,
    replyToId: draft.replyToId,
    createdAt: Date.now(),
    status: 'sending',
    reactions: [],
  };
  set((s) => ({
    messages: { ...s.messages, [conversationId]: [...(s.messages[conversationId] ?? []), message] },
  }));

  const setStatus = (status: Message['status']) =>
    set((s) => ({
      messages: updateMessage(s.messages, conversationId, id, (m) => ({ ...m, status })),
    }));
  setTimeout(() => setStatus('sent'), 350);
  setTimeout(() => setStatus('delivered'), 1100);
  setTimeout(() => setStatus('read'), 2200);

  const conversation = get().conversations[conversationId];
  if (!useDevSettings.getState().simulateReplies || conversation?.kind !== 'direct') return;
  const other = conversation.memberIds.find((m) => m !== ME);
  if (!other) return;
  const setTyping = (typing: boolean) =>
    set((s) => {
      const c = s.conversations[conversationId];
      return c
        ? {
            conversations: {
              ...s.conversations,
              [conversationId]: { ...c, typingUserIds: typing ? [other] : [] },
            },
          }
        : s;
    });
  setTimeout(() => setTyping(true), 2600);
  setTimeout(() => {
    setTyping(false);
    const reply: Message = {
      id: localId('msg'),
      conversationId,
      senderId: other,
      text: CANNED_REPLIES[counter % CANNED_REPLIES.length],
      createdAt: Date.now(),
      status: 'delivered',
      reactions: [],
    };
    set((s) => ({
      messages: { ...s.messages, [conversationId]: [...(s.messages[conversationId] ?? []), reply] },
    }));
  }, 4800);
}

function sampleCreate(set: SetFn, get: GetFn, others: string[], title?: string): string {
  const members = [ME, ...others];
  if (members.length === 2 && !title) {
    const existing = Object.values(get().conversations).find(
      (c) => c.kind === 'direct' && c.memberIds.includes(members[1]!),
    );
    if (existing) return existing.id;
  }
  const id = localId('conv');
  const conversation: Conversation = {
    id,
    kind: members.length > 2 || title ? 'group' : 'direct',
    title,
    memberIds: members,
    adminIds: [ME],
    pinned: false,
    muted: false,
    unreadCount: 0,
    typingUserIds: [],
    createdAt: Date.now(),
  };
  set((s) => ({
    conversations: { ...s.conversations, [id]: conversation },
    messages: { ...s.messages, [id]: [] },
  }));
  return id;
}

// ——— Selectors (pure, unit-tested) ———

export function conversationTitle(c: Conversation, contacts: Record<string, Contact>): string {
  if (c.kind === 'group') return c.title ?? 'Group';
  const other = c.memberIds.find((m) => m !== ME);
  return (other && contacts[other]?.displayName) || 'Unknown';
}

export function directContactId(c: Conversation): string | undefined {
  return c.kind === 'direct' ? c.memberIds.find((m) => m !== ME) : undefined;
}

export type ConversationSummary = {
  conversation: Conversation;
  title: string;
  lastMessage?: Message;
  lastActivity: number;
};

/** Pinned first, then most recent activity. */
export function summarizeConversations(
  conversations: Record<string, Conversation>,
  messages: Record<string, Message[]>,
  contacts: Record<string, Contact>,
): ConversationSummary[] {
  return Object.values(conversations)
    .map((conversation) => {
      const list = messages[conversation.id] ?? [];
      const lastMessage = list[list.length - 1];
      return {
        conversation,
        title: conversationTitle(conversation, contacts),
        lastMessage,
        lastActivity: lastMessage?.createdAt ?? conversation.createdAt,
      };
    })
    .sort(
      (a, b) =>
        Number(b.conversation.pinned) - Number(a.conversation.pinned) ||
        b.lastActivity - a.lastActivity,
    );
}

/** One-line preview text for a message, used in the chat list and reply quotes. */
export function messagePreview(m: Message | undefined): string {
  if (!m) return 'No messages yet';
  if (m.deleted) return 'Message deleted';
  if (m.undecryptable) return '🔒 Message';
  if (m.text) return m.text;
  switch (m.attachment?.kind) {
    case 'image':
      return '📷 Photo';
    case 'video':
      return '🎥 Video';
    case 'voice':
      return '🎤 Voice message';
    case 'document':
      return `📄 ${m.attachment.name}`;
    default:
      return '';
  }
}
