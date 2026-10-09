import type {
  AttachmentMeta,
  ConversationSummary,
  CreateAttachmentRequest,
  FileSecret,
  PublicUser,
  Reaction,
  SystemEvent,
} from '@koode/shared';

export type ReactionMark = { emoji: string; order: number; id: string; prev?: ReactionMark | null };

/** A file encrypted for upload: the ciphertext's location, key and digest. */
export type SealedFile = FileSecret & { uri: string; size: number };

/** An attachment as the app shows it, with what's needed to decrypt the download. */
export type LocalAttachment = AttachmentMeta & {
  /** Keys for the encrypted file and poster (absent for pre-encryption attachments). */
  secret?: { content: FileSecret; thumbnail: FileSecret | null };
};

/**
 * A file waiting to be sent. Files live in the app's outbox directory so a
 * pending send survives restarts; each step is remembered so a retry resumes.
 */
export type LocalUpload = {
  uri: string;
  /** Video poster (JPEG), uploaded next to it. */
  posterUri: string | null;
  /** What the file is (validated on the device; sent inside the encrypted message). */
  request: CreateAttachmentRequest;
  /** The encrypted copies actually uploaded (made once, so retries resume). */
  sealed?: SealedFile | null;
  posterSealed?: SealedFile | null;
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
  /** 'reaction' messages aren't shown: they set `reactions` on their target. */
  kind: 'text' | 'attachment' | 'system' | 'reaction';
  /** Text, caption, or (reaction) the emoji ('' = removed). */
  body: string;
  replyToId: string | null;
  attachment: LocalAttachment | null;
  system: SystemEvent | null;
  /** kind = reaction: the message reacted to. */
  targetId: string | null;
  /** Derived from reaction messages (latest per person). */
  reactions: Reaction[];
  /**
   * Per person, the reaction message that set `reactions` (its order = seq,
   * pending = newest). A pending one remembers what it replaced, so a failed
   * send can put it back.
   */
  reactionMarks?: Record<string, ReactionMark>;
  /**
   * Content came from this device (sent here) or was decrypted here. The
   * Double Ratchet can decrypt a message only once, so such content is never
   * replaced by a fresh decryption attempt.
   */
  opened?: boolean;
  /** Couldn't be decrypted (why, for the UI). */
  undecryptable?: 'failed' | 'identity' | 'missing' | null;
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
    targetId: m.targetId ?? null,
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
  /** Cached copies by id (including ones not loaded at start-up). */
  getMessages(ids: string[]): Promise<LocalMessage[]>;
  /** Cached messages before a sequence number, newest first. */
  olderMessages(conversationId: string, beforeSeq: number, limit: number): Promise<LocalMessage[]>;
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
    getMessages: async (ids) => ids.flatMap((id) => (messages.has(id) ? [messages.get(id)!] : [])),
    olderMessages: async (conversationId, beforeSeq, limit) =>
      [...messages.values()]
        .filter((m) => m.conversationId === conversationId && m.seq !== null && m.seq < beforeSeq)
        .sort((a, b) => b.seq! - a.seq!)
        .slice(0, limit),
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
