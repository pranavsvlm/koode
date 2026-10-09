import { z } from 'zod';

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

export const SendMessageRequest = z.object({
  id: MessageId,
  body: MessageBody,
  replyToId: MessageId.nullable().optional(),
});
export type SendMessageRequest = z.input<typeof SendMessageRequest>;

export const Message = z.object({
  id: z.string(),
  conversationId: z.string(),
  /** Per-conversation sequence assigned by the server; strictly increasing, may have gaps. */
  seq: z.number().int().positive(),
  senderId: z.string(),
  body: z.string(),
  replyToId: z.string().nullable(),
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
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

/** Frames the client sends. */
export const ClientFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('typing'), conversationId: z.string().min(1).max(64) }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;
