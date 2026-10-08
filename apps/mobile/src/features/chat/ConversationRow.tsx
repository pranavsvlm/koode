import { memo } from 'react';
import { Pressable, View } from 'react-native';
import { Avatar, Badge, Icon, Text } from '@/components/ui';
import { ME, type Contact } from '@/domain/types';
import { formatConversationTime } from '@/lib/format';
import { directContactId, messagePreview, type ConversationSummary } from '@/stores/chat';
import { MessageStatusIcon } from './MessageStatusIcon';
import { useThemeColors } from '@/theme/ThemeProvider';

export const ConversationRow = memo(function ConversationRow({
  summary,
  contacts,
  onPress,
}: {
  summary: ConversationSummary;
  contacts: Record<string, Contact>;
  onPress: (id: string) => void;
}) {
  const colors = useThemeColors();
  const { conversation: c, title, lastMessage } = summary;
  const otherId = directContactId(c);
  const other = otherId ? contacts[otherId] : undefined;
  const typingName = c.typingUserIds[0] ? contacts[c.typingUserIds[0]]?.displayName : undefined;
  const unread = c.unreadCount > 0;

  const senderPrefix =
    c.kind === 'group' && lastMessage && !lastMessage.deleted
      ? lastMessage.senderId === ME
        ? 'You'
        : contacts[lastMessage.senderId]?.displayName.split(' ')[0]
      : undefined;

  const preview = typingName
    ? c.kind === 'group'
      ? `${typingName.split(' ')[0]} is typing…`
      : 'typing…'
    : messagePreview(lastMessage);

  const a11y = [
    title,
    c.pinned && 'pinned',
    c.muted && 'muted',
    unread && `${c.unreadCount} unread`,
    senderPrefix ? `${senderPrefix}: ${preview}` : preview,
    lastMessage && formatConversationTime(lastMessage.createdAt),
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <Pressable
      onPress={() => onPress(c.id)}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      className="flex-row items-center gap-3 px-4 active:bg-fill"
      style={{ height: 76 }}
    >
      <Avatar
        id={otherId ?? c.id}
        name={title}
        size={56}
        online={other?.online}
        group={c.kind === 'group'}
      />
      <View className="h-full flex-1 justify-center gap-0.5 border-b border-separator pr-0.5">
        <View className="flex-row items-center gap-1.5">
          <Text variant="headline" numberOfLines={1} className="shrink">
            {title}
          </Text>
          {c.muted && <Icon name="message-off" size={12} color="text-tertiary" />}
          <View className="ml-auto flex-row items-center gap-1">
            {lastMessage?.senderId === ME && !lastMessage.deleted && (
              <MessageStatusIcon
                status={lastMessage.status}
                color={colors['text-tertiary']}
                readColor={colors.accent}
              />
            )}
            <Text variant="footnote" tone={unread && !c.muted ? 'accent' : 'tertiary'}>
              {lastMessage ? formatConversationTime(lastMessage.createdAt) : ''}
            </Text>
          </View>
        </View>
        <View className="flex-row items-start gap-2">
          <Text
            variant="subhead"
            tone={typingName ? 'accent' : 'secondary'}
            numberOfLines={2}
            className="flex-1"
          >
            {senderPrefix && !typingName && <Text variant="subhead">{senderPrefix}: </Text>}
            {preview}
          </Text>
          <View className="mt-0.5 flex-row items-center gap-1">
            {c.pinned && !unread && (
              <Icon
                name="pin"
                size={13}
                color="text-tertiary"
                style={{ transform: [{ rotate: '45deg' }] }}
              />
            )}
            <Badge count={c.unreadCount} muted={c.muted} />
          </View>
        </View>
      </View>
    </Pressable>
  );
});
