import { router, Stack, useLocalSearchParams } from 'expo-router';
import { ScrollView, View } from 'react-native';
import { Avatar, ListRow, ListSection, Text, useDialog, useToast } from '@/components/ui';
import { ME } from '@/domain/types';
import { detailOptions } from '@/navigation/options';
import { conversationTitle, useChat } from '@/stores/chat';
import { useSession } from '@/stores/session';
import { useThemeColors } from '@/theme/ThemeProvider';

export default function GroupInfoScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useThemeColors();
  const toast = useToast();
  const dialog = useDialog();
  const conversation = useChat((s) => s.conversations[id]);
  const contacts = useChat((s) => s.contacts);
  const setMuted = useChat((s) => s.setMuted);
  const me = useSession((s) => s.user);

  if (!conversation) return null;
  const title = conversationTitle(conversation, contacts);
  const iAmAdmin = conversation.adminIds.includes(ME);
  const later = (what: string) => () =>
    toast.show({ title: `${what} arrives with group features (Phase 7)` });

  return (
    <ScrollView className="bg-background" contentContainerClassName="gap-7 px-4 pb-16 pt-4">
      <Stack.Screen options={{ ...detailOptions(colors), title: 'Group Info' }} />
      <View className="items-center gap-2">
        <Avatar id={conversation.id} name={title} size={96} group />
        <Text variant="title2" className="mt-2 text-center">
          {title}
        </Text>
        <Text variant="subhead" tone="secondary">
          Group · {conversation.memberIds.length} members
        </Text>
      </View>

      <ListSection title={`${conversation.memberIds.length} Members`}>
        {iAmAdmin && (
          <ListRow icon="person-add" title="Add Members" onPress={later('Adding members')} />
        )}
        {conversation.memberIds.map((memberId) => {
          const isMe = memberId === ME;
          const contact = contacts[memberId];
          const name = isMe
            ? `${me?.displayName ?? 'You'} (You)`
            : (contact?.displayName ?? 'Unknown');
          return (
            <ListRow
              key={memberId}
              leading={
                <Avatar
                  id={isMe ? (me?.username ?? 'me') : memberId}
                  name={isMe ? (me?.displayName ?? 'You') : name}
                  size={32}
                />
              }
              title={name}
              subtitle={contact?.about}
              accessory={
                conversation.adminIds.includes(memberId)
                  ? { type: 'value', value: 'Admin' }
                  : { type: 'none' }
              }
              onPress={isMe ? undefined : () => router.push(`/contact/${memberId}`)}
            />
          );
        })}
      </ListSection>

      <ListSection>
        <ListRow
          icon="message-off"
          iconTint="text-secondary"
          title="Mute Notifications"
          accessory={{
            type: 'switch',
            value: conversation.muted,
            onValueChange: (v) => setMuted(id, v),
          }}
        />
        {iAmAdmin && (
          <ListRow
            icon="edit"
            title="Edit Group Name"
            accessory={{ type: 'chevron' }}
            onPress={later('Renaming groups')}
          />
        )}
      </ListSection>

      <ListSection footer="Group calls aren’t supported yet; calls are one-to-one in this version.">
        <ListRow
          title="Leave Group"
          destructive
          onPress={async () => {
            const ok = await dialog.confirm({
              title: `Leave “${title}”?`,
              message: 'You won’t receive new messages from this group.',
              confirmLabel: 'Leave',
              destructive: true,
            });
            if (ok) later('Leaving groups')();
          }}
        />
      </ListSection>
    </ScrollView>
  );
}
