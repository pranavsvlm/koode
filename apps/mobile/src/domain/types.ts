import type { ImageSourcePropType } from 'react-native';

/** The signed-in user's id in conversation membership and message senders. */
export const ME = 'me';

export type Contact = {
  id: string;
  displayName: string;
  username: string;
  about?: string;
  online?: boolean;
  lastSeenAt?: number;
};

export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

export type Attachment =
  | { kind: 'image'; source: ImageSourcePropType; width: number; height: number }
  | {
      kind: 'video';
      poster: ImageSourcePropType;
      width: number;
      height: number;
      durationSec: number;
    }
  | { kind: 'document'; name: string; sizeBytes: number; mimeType: string }
  | { kind: 'voice'; durationSec: number; waveform: number[] };

export type Reaction = { emoji: string; userIds: string[] };

export type Message = {
  id: string;
  conversationId: string;
  senderId: string;
  text?: string;
  attachment?: Attachment;
  createdAt: number;
  status: MessageStatus;
  replyToId?: string;
  reactions: Reaction[];
  deleted?: boolean;
};

export type Conversation = {
  id: string;
  kind: 'direct' | 'group';
  /** Group name; direct chats use the other member's name. */
  title?: string;
  memberIds: string[];
  adminIds: string[];
  pinned: boolean;
  muted: boolean;
  unreadCount: number;
  typingUserIds: string[];
  createdAt: number;
};

export type CallKind = 'voice' | 'video';

export type CallRecord = {
  id: string;
  contactId: string;
  kind: CallKind;
  direction: 'incoming' | 'outgoing';
  outcome: 'answered' | 'missed' | 'declined' | 'cancelled';
  startedAt: number;
  durationSec: number;
};

export const QUICK_REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🙏'] as const;
