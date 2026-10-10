import { z } from 'zod';
import { Call } from './calls';
import { OutgoingEnvelope, Envelope } from './keys';
import { StoredAttachment } from './media';

/** Client-generated message id (UUID v4). Makes sends idempotent across retries. */
export const MessageId = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'Invalid message id',
  );

export const MAX_MESSAGE_LENGTH = 4000;

export const MessageBody = z
  .string()
  .max(MAX_MESSAGE_LENGTH * 2) // pre-trim cap
  .transform((s) => s.trim())
  .pipe(z.string().min(1, 'Message is empty').max(MAX_MESSAGE_LENGTH, 'Message is too long'));

/** Most envelopes in one send: every device of every member of a full group. */
export const MAX_ENVELOPES = 1024;

/**
 * Send a message: one ciphertext per recipient device (every device of every
 * member, including my own other devices, but not this one). The server
 * checks the envelopes cover exactly the current devices (409 with a
 * DeviceMismatch otherwise). Plaintext is never accepted.
 */
export const SendMessageRequest = z
  .object({
    id: MessageId,
    kind: z.enum(['text', 'attachment', 'reaction']),
    envelopes: z.array(OutgoingEnvelope).max(MAX_ENVELOPES),
    /** kind = attachment: an encrypted upload to this conversation, not yet sent. */
    attachmentId: z.string().min(1).max(64).nullable().optional(),
    /** kind = reaction: the message reacted to. */
    targetId: MessageId.nullable().optional(),
  })
  .refine((m) => (m.kind === 'attachment') === !!m.attachmentId, {
    message: 'Attachment messages need an attachment (and only they may have one)',
    path: ['attachmentId'],
  })
  .refine((m) => (m.kind === 'reaction') === !!m.targetId, {
    message: 'Reactions need a target (and only they may have one)',
    path: ['targetId'],
  });
export type SendMessageRequest = z.input<typeof SendMessageRequest>;

/** Group changes, shown in the conversation ("Maya added Dan"). */
export const SystemEvent = z.object({
  action: z.enum(['created', 'renamed', 'added', 'removed', 'left', 'promoted', 'demoted']),
  actorId: z.string(),
  targetIds: z.array(z.string()),
  title: z.string().nullable(),
});
export type SystemEvent = z.infer<typeof SystemEvent>;

/** A reaction as shown (aggregated on the device from encrypted reaction messages). */
export const Reaction = z.object({ userId: z.string(), emoji: z.string() });
export type Reaction = z.infer<typeof Reaction>;

export const Message = z.object({
  id: z.string(),
  /** 'signal': content is in `envelopes`; 'none': plaintext from before Phase 8. */
  encryption: z.enum(['none', 'signal']),
  conversationId: z.string(),
  /** Per-conversation sequence assigned by the server; strictly increasing, may have gaps. */
  seq: z.number().int().positive(),
  /**
   * Per-conversation revision, bumped whenever the message changes (sent,
   * deleted). Catch-up asks for everything after a revision.
   */
  rev: z.number().int().nonnegative(),
  senderId: z.string(),
  /** The sender's Signal device number (null for plaintext and system messages). */
  senderDevice: z.number().int().nullable(),
  kind: z.enum(['text', 'attachment', 'system', 'reaction']),
  /** Plaintext messages only: text or caption. Encrypted ones keep it in the envelope. */
  body: z.string(),
  replyToId: z.string().nullable(),
  /** The stored file: for encrypted messages only its id, size and whether a poster exists. */
  attachment: StoredAttachment.nullable(),
  system: SystemEvent.nullable(),
  /** kind = reaction: the message reacted to. */
  targetId: z.string().nullable(),
  /** Ciphertexts for the reader's own devices (each device decrypts its own). */
  envelopes: z.array(Envelope),
  /** Deleted for everyone (content removed; the message stays as a marker). */
  deletedAt: z.number().int().nullable(),
  /** Server receive time (epoch ms). */
  createdAt: z.number().int(),
});
export type Message = z.infer<typeof Message>;

export const MessagePage = z.object({ messages: z.array(Message), hasMore: z.boolean() });
export type MessagePage = z.infer<typeof MessagePage>;

export const ConversationMember = z.object({
  userId: z.string(),
  role: z.enum(['member', 'admin']),
  lastDeliveredSeq: z.number().int(),
  lastReadSeq: z.number().int(),
});
export type ConversationMember = z.infer<typeof ConversationMember>;

export const ConversationSummary = z.object({
  id: z.string(),
  kind: z.enum(['direct', 'group']),
  title: z.string().nullable(),
  createdAt: z.number().int(),
  lastSeq: z.number().int(),
  /** Highest message revision in the conversation. */
  lastRev: z.number().int(),
  lastMessage: Message.nullable(),
  members: z.array(ConversationMember),
  /** Messages from others after my read position. */
  unreadCount: z.number().int(),
});
export type ConversationSummary = z.infer<typeof ConversationSummary>;
export const ConversationList = z.object({ conversations: z.array(ConversationSummary) });

export const CreateConversationRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('direct'), userId: z.string().min(1).max(64) }),
  z.object({
    kind: z.literal('group'),
    title: z.string().trim().min(1).max(64),
    memberIds: z.array(z.string().min(1).max(64)).min(1).max(63),
  }),
]);
export type CreateConversationRequest = z.input<typeof CreateConversationRequest>;

export const MAX_GROUP_MEMBERS = 64;
export const GroupTitle = z.string().trim().min(1).max(64);
export const RenameGroupRequest = z.object({ title: GroupTitle });
export const AddMembersRequest = z.object({
  userIds: z.array(z.string().min(1).max(64)).min(1).max(MAX_GROUP_MEMBERS),
});
export const UpdateMemberRequest = z.object({ role: z.enum(['member', 'admin']) });

export const ReceiptRequest = z
  .object({
    delivered: z.number().int().nonnegative().optional(),
    read: z.number().int().nonnegative().optional(),
    /** When false, my read position updates (for unread counts) but isn't shown to others. */
    shareRead: z.boolean().default(true),
  })
  .refine((r) => r.delivered !== undefined || r.read !== undefined, 'Nothing to acknowledge');
export type ReceiptRequest = z.input<typeof ReceiptRequest>;

export const PublicUser = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  about: z.string(),
  /**
   * Presence, only for people I share a chat with, and only if we both show
   * it (hiding mine hides theirs, as with read receipts). Absent otherwise.
   */
  online: z.boolean().optional(),
  lastSeenAt: z.number().int().nullable().optional(),
});
export type PublicUser = z.infer<typeof PublicUser>;
export const UserDirectory = z.object({ users: z.array(PublicUser) });

// ——— Realtime (WebSocket) protocol ———

/** Frames the server sends. */
export const ServerEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('pong') }),
  z.object({ type: z.literal('message'), message: Message }),
  z.object({
    type: z.literal('receipt'),
    conversationId: z.string(),
    userId: z.string(),
    deliveredSeq: z.number().int(),
    readSeq: z.number().int(),
  }),
  z.object({ type: z.literal('typing'), conversationId: z.string(), userId: z.string() }),
  /** A conversation you belong to was created or changed: re-sync it. */
  z.object({ type: z.literal('conversation'), conversationId: z.string() }),
  /** A call you're part of was created or changed state. */
  z.object({ type: z.literal('call'), call: Call }),
  /** Someone you share a chat with came online or went offline. */
  z.object({
    type: z.literal('presence'),
    userId: z.string(),
    online: z.boolean(),
    lastSeenAt: z.number().int().nullable(),
  }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

/** Frames the client sends. */
export const ClientFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('typing'), conversationId: z.string().min(1).max(64) }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;
