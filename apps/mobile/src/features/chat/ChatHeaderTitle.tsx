import { Pressable, View } from 'react-native';
import { Avatar, Text } from '@/components/ui';
import { ME, type Contact, type Conversation } from '@/domain/types';
import { formatLastSeen } from '@/lib/format';

export function chatSubtitle(
  c: Conversation,
  contacts: Record<string, Contact>,
  showTyping: boolean,
): string {
  const typer = showTyping ? c.typingUserIds[0] : undefined;
  if (c.kind === 'group') {
    if (typer) return `${contacts[typer]?.displayName.split(' ')[0] ?? 'Someone'} is typing…`;
    return `${c.memberIds.length} members`;
  }
  if (typer) return 'typing…';
  const other = contacts[c.memberIds.find((m) => m !== ME) ?? ''];
  if (!other) return '';
  if (other.online) return 'online';
  // Live accounts have no presence yet: show the username rather than guess.
  return other.lastSeenAt !== undefined ? formatLastSeen(other.lastSeenAt) : `@${other.username}`;
}

export function ChatHeaderTitle({
  conversation,
  title,
  contacts,
  showTyping,
  onPress,
}: {
  conversation: Conversation;
  title: string;
  contacts: Record<string, Contact>;
  showTyping: boolean;
  onPress: () => void;
}) {
  const otherId =
    conversation.kind === 'direct' ? conversation.memberIds.find((m) => m !== ME) : undefined;
  const subtitle = chatSubtitle(conversation, contacts, showTyping);
  const live = subtitle === 'online' || subtitle.endsWith('typing…');

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${subtitle}. Show details`}
      className="flex-row items-center gap-2.5 active:opacity-70"
    >
      <Avatar
        id={otherId ?? conversation.id}
        name={title}
        size={34}
        group={conversation.kind === 'group'}
      />
      <View>
        <Text variant="headline" numberOfLines={1} style={{ maxWidth: 190 }}>
          {title}
        </Text>
        <Text variant="caption" tone={live ? 'accent' : 'secondary'} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
    </Pressable>
  );
}
