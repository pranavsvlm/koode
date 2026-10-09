import type {
  AttachmentMeta,
  ConversationSummary,
  CreateAttachmentRequest,
  PublicUser,
  Reaction,
  SystemEvent,
} from '@koode/shared';

/**
 * A file waiting to be sent. Files live in the app's outbox directory so a
 * pending send survives restarts; each step is remembered so a retry resumes.
 */
export type LocalUpload = {
  uri: string;
  /** Video poster (JPEG), uploaded next to it. */
  posterUri: string | null;
  request: CreateAttachmentRequest;
  attachmentId: string | null;
  posterUploaded: boolean;
  uploaded: boolean;
};

/**
 * A message as the app holds it. `seq` is null until the server has accepted
 * it; `state` tracks the local outbox.
 */
export type LocalMessage = {
  id: string;
  conversationId: string;
  seq: number | null;
  /** Server revision (last change); null until accepted. */
  rev: number | null;
  senderId: string;
  kind: 'text' | 'attachment' | 'system';
  body: string;
  replyToId: string | null;
  attachment: AttachmentMeta | null;
  system: SystemEvent | null;
  reactions: Reaction[];
  deletedAt: number | null;
  createdAt: number;
  state: 'pending' | 'sent' | 'failed';
  /** Outgoing file not yet sent. */
  upload?: LocalUpload;
};

/** Fills fields added after a message was cached (older app versions). */
export function normalizeMessage(
  m: Partial<LocalMessage> & Pick<LocalMessage, 'id'>,
): LocalMessage {
  return {
    conversationId: '',
    seq: null,
    senderId: '',
    body: '',
    replyToId: null,
    createdAt: 0,
    state: 'sent',
    ...m,
    rev: m.rev ?? null,
    kind: m.kind ?? 'text',
    attachment: m.attachment ?? null,
    system: m.system ?? null,
    reactions: m.reactions ?? [],
    deletedAt: m.deletedAt ?? null,
  };
}

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
  /** Upload progress (0–1) of pending messages with files. */
  progress: Record<string, number>;
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
  deleteMessages(ids: string[]): Promise<void>;
  /** The conversation and its messages (left or removed from a group). */
  removeConversation(id: string): Promise<void>;
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
    deleteMessages: async (ids) => ids.forEach((id) => messages.delete(id)),
    removeConversation: async (id) => {
      conversations.delete(id);
      for (const [k, m] of messages) if (m.conversationId === id) messages.delete(k);
    },
    clear: async () => {
      conversations.clear();
      users.clear();
      messages.clear();
    },
    dump: () => ({ messages: [...messages.values()] }),
  };
}
