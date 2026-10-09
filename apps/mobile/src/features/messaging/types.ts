import type { ConversationSummary, PublicUser } from '@koode/shared';

/**
 * A message as the app holds it. `seq` is null until the server has accepted
 * it; `state` tracks the local outbox.
 */
export type LocalMessage = {
  id: string;
  conversationId: string;
  seq: number | null;
  senderId: string;
  body: string;
  replyToId: string | null;
  createdAt: number;
  state: 'pending' | 'sent' | 'failed';
};

export type Snapshot = {
  connection: 'connecting' | 'online' | 'offline';
  /** Newest activity first. */
  conversations: ConversationSummary[];
  /** Per conversation, oldest → newest. */
  messages: Record<string, LocalMessage[]>;
  users: Record<string, PublicUser>;
  /** User ids currently typing, per conversation. */
  typing: Record<string, string[]>;
  /** Whether older history exists on the server, per conversation. */
  hasMore: Record<string, boolean>;
};

/** Durable local cache (SQLite in the app, memory in tests). */
export interface MessagingStore {
  load(): Promise<{
    conversations: ConversationSummary[];
    messages: LocalMessage[];
    users: PublicUser[];
  }>;
  saveConversations(conversations: ConversationSummary[]): Promise<void>;
  saveUsers(users: PublicUser[]): Promise<void>;
  saveMessages(messages: LocalMessage[]): Promise<void>;
  clear(): Promise<void>;
}

export function memoryStore(): MessagingStore & { dump: () => { messages: LocalMessage[] } } {
  const conversations = new Map<string, ConversationSummary>();
  const users = new Map<string, PublicUser>();
  const messages = new Map<string, LocalMessage>();
  return {
    load: async () => ({
      conversations: [...conversations.values()],
      messages: [...messages.values()],
      users: [...users.values()],
    }),
    saveConversations: async (list) => list.forEach((c) => conversations.set(c.id, c)),
    saveUsers: async (list) => list.forEach((u) => users.set(u.id, u)),
    saveMessages: async (list) => list.forEach((m) => messages.set(m.id, m)),
    clear: async () => {
      conversations.clear();
      users.clear();
      messages.clear();
    },
    dump: () => ({ messages: [...messages.values()] }),
  };
}
