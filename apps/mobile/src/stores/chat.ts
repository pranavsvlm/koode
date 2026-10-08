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
} from '@/domain/types';

/**
 * DEVELOPMENT CHAT STORE — in-memory data seeded from fixtures, with simulated
 * delivery, receipts and replies so the UI can be reviewed end to end.
 * Phase 4 replaces this with the WebSocket sync engine and the SQLite cache;
 * screens depend only on the shape of this store.
 */

export type Draft = { text?: string; attachment?: Attachment; replyToId?: string };

type ChatState = {
  status: 'idle' | 'loading' | 'ready';
  contacts: Record<string, Contact>;
  conversations: Record<string, Conversation>;
  /** Per conversation, oldest → newest. */
  messages: Record<string, Message[]>;
  calls: CallRecord[];
  load: () => Promise<void>;
  send: (conversationId: string, draft: Draft) => void;
  toggleReaction: (conversationId: string, messageId: string, emoji: string) => void;
  deleteMessage: (conversationId: string, messageId: string) => void;
  markRead: (conversationId: string) => void;
  setPinned: (conversationId: string, pinned: boolean) => void;
  setMuted: (conversationId: string, muted: boolean) => void;
  createConversation: (memberIds: string[], title?: string) => string;
  addCall: (call: Omit<CallRecord, 'id'>) => void;
};

let counter = 0;
const localId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++counter}`;

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

export const useChat = create<ChatState>((set, get) => ({
  status: 'idle',
  contacts: {},
  conversations: {},
  messages: {},
  calls: [],

  load: async () => {
    if (get().status !== 'idle') return;
    set({ status: 'loading' });
    const { slowLoading, emptyData } = useDevSettings.getState();
    if (slowLoading) await new Promise((r) => setTimeout(r, 1500));
    const data = buildFixtures();
    const messages: Record<string, Message[]> = {};
    for (const m of data.messages) (messages[m.conversationId] ??= []).push(m);
    for (const list of Object.values(messages)) list.sort((a, b) => a.createdAt - b.createdAt);
    set({
      status: 'ready',
      contacts: Object.fromEntries(data.contacts.map((c) => [c.id, c])),
      conversations: emptyData ? {} : Object.fromEntries(data.conversations.map((c) => [c.id, c])),
      messages: emptyData ? {} : messages,
      calls: emptyData ? [] : data.calls,
    });
  },

  send: (conversationId, draft) => {
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
      messages: {
        ...s.messages,
        [conversationId]: [...(s.messages[conversationId] ?? []), message],
      },
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
        if (!c) return s;
        return {
          conversations: {
            ...s.conversations,
            [conversationId]: { ...c, typingUserIds: typing ? [other] : [] },
          },
        };
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
        messages: {
          ...s.messages,
          [conversationId]: [...(s.messages[conversationId] ?? []), reply],
        },
      }));
    }, 4800);
  },

  toggleReaction: (conversationId, messageId, emoji) =>
    set((s) => ({
      messages: updateMessage(s.messages, conversationId, messageId, (m) => {
        const mine = m.reactions.find((r) => r.userIds.includes(ME));
        // One reaction per person: remove my previous one, then add unless toggling off.
        let reactions = m.reactions
          .map((r) => ({ ...r, userIds: r.userIds.filter((u) => u !== ME) }))
          .filter((r) => r.userIds.length > 0);
        if (mine?.emoji !== emoji) {
          const existing = reactions.find((r) => r.emoji === emoji);
          reactions = existing
            ? reactions.map((r) => (r.emoji === emoji ? { ...r, userIds: [...r.userIds, ME] } : r))
            : [...reactions, { emoji, userIds: [ME] }];
        }
        return { ...m, reactions };
      }),
    })),

  deleteMessage: (conversationId, messageId) =>
    set((s) => ({
      messages: updateMessage(s.messages, conversationId, messageId, (m) => ({
        ...m,
        deleted: true,
        text: undefined,
        attachment: undefined,
        reactions: [],
      })),
    })),

  markRead: (conversationId) =>
    set((s) => {
      const c = s.conversations[conversationId];
      if (!c || c.unreadCount === 0) return s;
      return { conversations: { ...s.conversations, [conversationId]: { ...c, unreadCount: 0 } } };
    }),

  setPinned: (conversationId, pinned) =>
    set((s) => {
      const c = s.conversations[conversationId];
      return c ? { conversations: { ...s.conversations, [conversationId]: { ...c, pinned } } } : s;
    }),

  setMuted: (conversationId, muted) =>
    set((s) => {
      const c = s.conversations[conversationId];
      return c ? { conversations: { ...s.conversations, [conversationId]: { ...c, muted } } } : s;
    }),

  createConversation: (memberIds, title) => {
    const members = [ME, ...memberIds.filter((m) => m !== ME)];
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
  },

  addCall: (call) => set((s) => ({ calls: [{ id: localId('call'), ...call }, ...s.calls] })),
}));

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
