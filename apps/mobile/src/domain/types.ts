import type { FileSecret } from '@koode/shared';
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

/**
 * Where an attachment's file is. Live attachments are downloaded on demand
 * (with the user's credentials) and cached by `attachmentId`; sample data uses
 * bundled `source`/`poster` images.
 */
export type MediaRef = {
  /** Server attachment id. */
  attachmentId?: string;
  mimeType?: string;
  /** A file already on this device (being sent). */
  localUri?: string;
  /** Video poster on this device (being sent). */
  localPosterUri?: string;
  /** Tiny base64 JPEG shown while the real image loads. */
  preview?: string | null;
  /** Video has a poster on the server. */
  hasPoster?: boolean;
  /** Upload progress (0–1) while sending. */
  progress?: number;
  /** Keys to decrypt the downloaded file and poster (end-to-end encrypted attachments). */
  secret?: { content: FileSecret; thumbnail: FileSecret | null };
};

export type Attachment =
  | ({ kind: 'image'; source?: ImageSourcePropType; width: number; height: number } & MediaRef)
  | ({
      kind: 'video';
      poster?: ImageSourcePropType;
      width: number;
      height: number;
      durationSec: number;
    } & MediaRef)
  | ({ kind: 'document'; name: string; sizeBytes: number; mimeType: string } & MediaRef)
  | ({ kind: 'voice'; durationSec: number; waveform: number[] } & MediaRef);

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
  /** Arrived but couldn't be decrypted on this device. */
  undecryptable?: 'failed' | 'identity' | 'missing';
  /** Group change ("Maya added Dan"), shown as a centred note, not a bubble. */
  system?: string;
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
