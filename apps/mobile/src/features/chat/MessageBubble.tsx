import { memo } from 'react';
import { Pressable, useWindowDimensions, View, type ViewStyle } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Avatar, Icon, Text } from '@/components/ui';
import { ME, type Contact, type Message } from '@/domain/types';
import { formatDuration, formatFileSize, formatTime } from '@/lib/format';
import { haptics } from '@/lib/haptics';
import { cn } from '@/lib/cn';
import type { ChatTextSize } from '@/stores/preferences';
import { messagePreview } from '@/stores/chat';
import { useThemeColors } from '@/theme/ThemeProvider';
import type { GroupPosition } from './items';
import { MessageStatusIcon, statusLabel } from './MessageStatusIcon';
import { BubbleMedia, fileTypeLabel } from './BubbleMedia';
import { SwipeToReply } from './SwipeToReply';
import { VoiceMessage } from './VoiceMessage';

const BIG = 20;
const SMALL = 6;
const MEDIA_MAX_WIDTH = 248;

function bubbleRadii(position: GroupPosition, outgoing: boolean): ViewStyle {
  const top = position === 'middle' || position === 'last' ? SMALL : BIG;
  const bottom = position === 'first' || position === 'middle' ? SMALL : BIG;
  return outgoing
    ? {
        borderTopLeftRadius: BIG,
        borderBottomLeftRadius: BIG,
        borderTopRightRadius: top,
        borderBottomRightRadius: bottom,
      }
    : {
        borderTopRightRadius: BIG,
        borderBottomRightRadius: BIG,
        borderTopLeftRadius: top,
        borderBottomLeftRadius: bottom,
      };
}

const TEXT_SIZE: Record<ChatTextSize, { fontSize: number; lineHeight: number }> = {
  small: { fontSize: 15, lineHeight: 20 },
  default: { fontSize: 17, lineHeight: 22 },
  large: { fontSize: 20, lineHeight: 26 },
};

export type MessageBubbleProps = {
  message: Message;
  position: GroupPosition;
  sender?: Contact;
  showSender: boolean;
  showAvatar: boolean;
  isGroup: boolean;
  replyTo?: Message;
  replyToName?: string;
  textSize: ChatTextSize;
  /** Animate in: only for messages that arrive while the chat is open. */
  isNew: boolean;
  onLongPress: (message: Message) => void;
  onReply: (message: Message) => void;
  onOpenMedia: (message: Message) => void;
  onToggleReaction: (message: Message, emoji: string) => void;
  onOpenDocument: (message: Message) => void;
  /** Tap a failed message to send it again. */
  onRetry?: (message: Message) => void;
};

export const MessageBubble = memo(function MessageBubble({
  message,
  position,
  sender,
  showSender,
  showAvatar,
  isGroup,
  replyTo,
  replyToName,
  textSize,
  isNew,
  onLongPress,
  onReply,
  onOpenMedia,
  onToggleReaction,
  onOpenDocument,
  onRetry,
}: MessageBubbleProps) {
  const colors = useThemeColors();
  const { width: windowWidth } = useWindowDimensions();
  const outgoing = message.senderId === ME;
  const attachment = message.deleted ? undefined : message.attachment;
  const isVisual = attachment?.kind === 'image' || attachment?.kind === 'video';
  const mediaOnly = isVisual && !message.text && !replyTo;
  const time = formatTime(message.createdAt);
  const gapTop = position === 'first' || position === 'single' ? 'mt-2' : 'mt-0.5';

  const metaColor =
    outgoing && !message.deleted ? 'rgba(255,255,255,0.75)' : colors['text-tertiary'];
  const meta = (
    <View className="ml-2 flex-row items-center gap-1 self-end" style={{ marginBottom: 1 }}>
      <Text variant="caption" style={{ color: mediaOnly ? '#FFFFFF' : metaColor, fontSize: 11 }}>
        {time}
      </Text>
      {outgoing && !message.deleted && (
        <MessageStatusIcon
          status={message.status}
          color={mediaOnly ? '#FFFFFF' : metaColor}
          readColor={mediaOnly ? '#FFFFFF' : outgoing ? '#FFFFFF' : colors.accent}
        />
      )}
    </View>
  );

  const a11yLabel = [
    outgoing ? 'You' : (sender?.displayName ?? 'Someone'),
    messagePreview(message),
    time,
    outgoing ? statusLabel(message.status) : undefined,
    message.reactions.length
      ? `Reactions: ${message.reactions.map((r) => r.emoji).join(' ')}`
      : undefined,
  ]
    .filter(Boolean)
    .join(', ');

  const bubbleBg = message.deleted
    ? 'bg-fill'
    : outgoing
      ? 'bg-bubble-outgoing'
      : 'bg-bubble-incoming';
  const textTone = message.deleted ? 'tertiary' : outgoing ? 'inverse' : 'primary';

  const bubble = (
    <Pressable
      onLongPress={() => {
        if (message.deleted) return;
        haptics.press();
        onLongPress(message);
      }}
      onPress={
        message.status === 'failed' && outgoing && onRetry
          ? () => onRetry(message)
          : isVisual
            ? () => onOpenMedia(message)
            : attachment?.kind === 'document'
              ? () => onOpenDocument(message)
              : undefined
      }
      delayLongPress={280}
      accessible
      accessibilityLabel={a11yLabel}
      accessibilityHint={message.deleted ? undefined : 'Double tap and hold for options'}
      accessibilityActions={
        message.deleted
          ? []
          : [
              { name: 'reply', label: 'Reply' },
              { name: 'longpress', label: 'More options' },
            ]
      }
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'reply') onReply(message);
        if (e.nativeEvent.actionName === 'longpress') onLongPress(message);
      }}
      className={cn('overflow-hidden', !mediaOnly && bubbleBg)}
      style={[
        bubbleRadii(position, outgoing),
        // Percentages don't resolve against a shrink-wrapped parent, so size from the window.
        { maxWidth: isVisual ? MEDIA_MAX_WIDTH : Math.min(windowWidth * 0.78, 520) },
      ]}
    >
      {replyTo && (
        <View
          className={cn(
            'mx-1.5 mt-1.5 rounded-[12px] px-2.5 py-1.5',
            outgoing ? 'bg-white/15' : 'bg-text/5',
          )}
          style={{ borderLeftWidth: 3, borderLeftColor: outgoing ? '#FFFFFF' : colors.accent }}
        >
          <Text variant="caption" tone={outgoing ? 'inverse' : 'accent'} className="font-semibold">
            {replyToName}
          </Text>
          <Text
            variant="footnote"
            tone={outgoing ? 'inverse' : 'secondary'}
            numberOfLines={1}
            style={outgoing ? { opacity: 0.85 } : undefined}
          >
            {messagePreview(replyTo)}
          </Text>
        </View>
      )}

      {isVisual && (
        <View>
          <BubbleMedia
            attachment={attachment}
            style={{
              width: MEDIA_MAX_WIDTH,
              height: Math.min(
                330,
                Math.max(160, (MEDIA_MAX_WIDTH * attachment.height) / attachment.width),
              ),
            }}
          />
          {attachment.kind === 'video' && (
            <View className="absolute inset-0 items-center justify-center">
              <View className="h-12 w-12 items-center justify-center rounded-full bg-black/45">
                <Icon name="play" size={20} color="#FFFFFF" />
              </View>
              <View className="absolute left-2 top-2 rounded-full bg-black/45 px-2 py-0.5">
                <Text variant="caption" style={{ color: '#FFFFFF' }}>
                  {formatDuration(attachment.durationSec)}
                </Text>
              </View>
            </View>
          )}
          {mediaOnly && (
            <View className="absolute bottom-2 right-2 rounded-full bg-black/40 px-2 py-0.5">
              {meta}
            </View>
          )}
        </View>
      )}

      {attachment?.kind === 'document' && (
        <View className="flex-row items-center gap-3 px-3 pt-2.5">
          <View
            className={cn(
              'h-11 w-11 items-center justify-center rounded-md',
              outgoing ? 'bg-white/20' : 'bg-accent/15',
            )}
          >
            <Icon name="document" size={20} color={outgoing ? '#FFFFFF' : 'accent'} />
          </View>
          <View className="shrink">
            <Text
              variant="subhead"
              tone={outgoing ? 'inverse' : 'primary'}
              className="font-semibold"
              numberOfLines={1}
            >
              {attachment.name}
            </Text>
            <Text
              variant="caption"
              tone={outgoing ? 'inverse' : 'secondary'}
              style={outgoing ? { opacity: 0.8 } : undefined}
            >
              {attachment.progress !== undefined
                ? `Sending ${Math.round(attachment.progress * 100)}%`
                : `${formatFileSize(attachment.sizeBytes)} · ${fileTypeLabel(attachment.name, attachment.mimeType)}`}
            </Text>
          </View>
        </View>
      )}

      {attachment?.kind === 'voice' && (
        <View className="px-3 pt-2">
          <VoiceMessage attachment={attachment} outgoing={outgoing} />
        </View>
      )}

      {!mediaOnly && (
        <View className="flex-row flex-wrap items-end justify-end px-3 pb-[7px] pt-[7px]">
          {message.deleted ? (
            <View className="mr-auto flex-row items-center gap-1.5">
              <Icon name="trash" size={13} color="text-tertiary" />
              <Text variant="body" tone="tertiary" className="italic" style={TEXT_SIZE[textSize]}>
                Message deleted
              </Text>
            </View>
          ) : message.text ? (
            <Text
              tone={textTone}
              className="mr-auto shrink"
              style={TEXT_SIZE[textSize]}
              selectable={false}
            >
              {message.text}
            </Text>
          ) : null}
          {meta}
        </View>
      )}
    </Pressable>
  );

  const reactions = message.reactions.length > 0 && (
    <View className={cn('-mt-1.5 flex-row gap-1', outgoing ? 'mr-2 self-end' : 'ml-2 self-start')}>
      {message.reactions.map((r) => {
        const mine = r.userIds.includes(ME);
        return (
          <Pressable
            key={r.emoji}
            onPress={() => {
              haptics.selection();
              onToggleReaction(message, r.emoji);
            }}
            accessibilityRole="button"
            accessibilityLabel={`${r.emoji} ${r.userIds.length}${mine ? ', including you' : ''}`}
            className={cn(
              'h-6 flex-row items-center gap-1 rounded-full border-2 border-background px-1.5',
              mine ? 'bg-accent/20' : 'bg-fill',
            )}
          >
            <Text style={{ fontSize: 12, lineHeight: 15 }}>{r.emoji}</Text>
            {r.userIds.length > 1 && (
              <Text
                variant="caption"
                tone={mine ? 'accent' : 'secondary'}
                className="font-semibold"
              >
                {r.userIds.length}
              </Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );

  const content = (
    <View
      className={cn('flex-row items-end px-3', gapTop, outgoing ? 'justify-end' : 'justify-start')}
    >
      {isGroup && !outgoing && (
        <View className="mr-2 w-7">
          {showAvatar && sender && <Avatar id={sender.id} name={sender.displayName} size={28} />}
        </View>
      )}
      <View
        className={cn('max-w-full', outgoing ? 'items-end' : 'items-start')}
        style={{ flexShrink: 1 }}
      >
        {showSender && !outgoing && sender && (
          <Text variant="caption" tone="secondary" className="mb-1 ml-3 font-semibold">
            {sender.displayName}
          </Text>
        )}
        {bubble}
        {reactions}
      </View>
    </View>
  );

  return (
    <Animated.View entering={isNew ? FadeInDown.springify().damping(20).stiffness(220) : undefined}>
      {message.deleted ? (
        content
      ) : (
        <SwipeToReply onReply={() => onReply(message)}>{content}</SwipeToReply>
      )}
    </Animated.View>
  );
});
