import { Image } from 'expo-image';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import {
  Avatar,
  Icon,
  ListRow,
  ListSection,
  PressableScale,
  Text,
  useDialog,
  useToast,
  type IconName,
} from '@/components/ui';
import { openConversation } from '@/features/chat/openConversation';
import { formatLastSeen } from '@/lib/format';
import { detailOptions } from '@/navigation/options';
import { useChat } from '@/stores/chat';
import { useThemeColors } from '@/theme/ThemeProvider';

function Action({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      className="flex-1 items-center gap-1.5 rounded-xl bg-surface py-3"
    >
      <Icon name={icon} size={22} color="accent" />
      <Text variant="caption" tone="accent" className="font-semibold">
        {label}
      </Text>
    </PressableScale>
  );
}

export default function ContactScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useThemeColors();
  const toast = useToast();
  const dialog = useDialog();
  const contact = useChat((s) => s.contacts[id]);
  const conversations = useChat((s) => s.conversations);
  const messages = useChat((s) => s.messages);

  const direct = useMemo(
    () => Object.values(conversations).find((c) => c.kind === 'direct' && c.memberIds.includes(id)),
    [conversations, id],
  );
  const media = useMemo(
    () =>
      (direct ? (messages[direct.id] ?? []) : [])
        .filter(
          (m) => !m.deleted && (m.attachment?.kind === 'image' || m.attachment?.kind === 'video'),
        )
        .reverse(),
    [direct, messages],
  );

  if (!contact) return null;

  return (
    <ScrollView className="bg-background" contentContainerClassName="gap-7 px-4 pb-16 pt-4">
      <Stack.Screen options={{ ...detailOptions(colors), title: '' }} />
      <View className="items-center gap-1">
        <Avatar id={contact.id} name={contact.displayName} size={112} online={contact.online} />
        <Text variant="title1" className="mt-3 text-center">
          {contact.displayName}
        </Text>
        <Text variant="subhead" tone={contact.online ? 'accent' : 'secondary'}>
          @{contact.username}
          {contact.online
            ? ' · online'
            : contact.lastSeenAt !== undefined
              ? ` · ${formatLastSeen(contact.lastSeenAt)}`
              : ''}
        </Text>
        {contact.about && (
          <Text variant="body" tone="secondary" className="mt-2 text-center">
            {contact.about}
          </Text>
        )}
      </View>

      <View className="flex-row gap-2.5">
        <Action
          icon="message"
          label="Message"
          onPress={() =>
            openConversation([contact.id]).catch(() =>
              toast.show({ title: 'Couldn’t open the chat', tone: 'error' }),
            )
          }
        />
        <Action
          icon="phone"
          label="Call"
          onPress={() =>
            router.push({ pathname: '/call/[id]', params: { id: contact.id, kind: 'voice' } })
          }
        />
        <Action
          icon="video"
          label="Video"
          onPress={() =>
            router.push({ pathname: '/call/[id]', params: { id: contact.id, kind: 'video' } })
          }
        />
      </View>

      {media.length > 0 && (
        <View className="gap-1.5">
          <Text variant="footnote" tone="secondary" className="ml-4 font-medium uppercase">
            Shared Media
          </Text>
          <View className="flex-row flex-wrap gap-1 overflow-hidden rounded-xl">
            {media.slice(0, 6).map((m) => {
              const a = m.attachment!;
              const source =
                a.kind === 'image' ? a.source : a.kind === 'video' ? a.poster : undefined;
              return (
                <Pressable
                  key={m.id}
                  onPress={() =>
                    router.push({
                      pathname: '/media/[id]',
                      params: { id: m.id, conversationId: direct!.id },
                    })
                  }
                  accessibilityRole="imagebutton"
                  accessibilityLabel={a.kind === 'video' ? 'Video' : 'Photo'}
                  style={{ width: '32.6%', aspectRatio: 1 }}
                >
                  <Image source={source} style={{ flex: 1 }} contentFit="cover" />
                </Pressable>
              );
            })}
          </View>
        </View>
      )}

      <ListSection
        title="Security"
        footer="Safety numbers let you confirm you’re talking to the right person. They’ll be available once end-to-end encryption ships."
      >
        <ListRow
          icon="shield"
          iconTint="text-tertiary"
          title="Verify Safety Number"
          subtitle="Not available yet"
        />
      </ListSection>

      <ListSection>
        <ListRow
          title={`Block ${contact.displayName.split(' ')[0]}`}
          destructive
          onPress={async () => {
            const ok = await dialog.confirm({
              title: `Block ${contact.displayName}?`,
              message: 'They won’t be able to message or call you. They won’t be told.',
              confirmLabel: 'Block',
              destructive: true,
            });
            if (ok) toast.show({ title: 'Blocking arrives with account features (Phase 3)' });
          }}
        />
      </ListSection>
    </ScrollView>
  );
}
