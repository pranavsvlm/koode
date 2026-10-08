import { router, Stack } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, SectionList, Share, View } from 'react-native';
import {
  Avatar,
  Button,
  EmptyState,
  Icon,
  IconButton,
  Sheet,
  SkeletonList,
  Text,
  useToast,
} from '@/components/ui';
import type { Contact } from '@/domain/types';
import { formatLastSeen } from '@/lib/format';
import { useChat } from '@/stores/chat';

function sections(contacts: Contact[]) {
  const map = new Map<string, Contact[]>();
  for (const c of [...contacts].sort((a, b) => a.displayName.localeCompare(b.displayName))) {
    const letter = c.displayName[0]?.toUpperCase() ?? '#';
    map.set(letter, [...(map.get(letter) ?? []), c]);
  }
  return [...map.entries()].map(([title, data]) => ({ title, data }));
}

export default function ContactsScreen() {
  const status = useChat((s) => s.status);
  const contacts = useChat((s) => s.contacts);
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);

  const data = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = Object.values(contacts).filter(
      (c) => !q || c.displayName.toLowerCase().includes(q) || c.username.includes(q),
    );
    return sections(list);
  }, [contacts, query]);

  // Dev placeholder; real single-use invites are minted by the server in Phase 3.
  const inviteCode = 'K7QM-4XRT-9PWD';

  return (
    <>
      <Stack.Screen
        options={{
          headerSearchBarOptions: {
            placeholder: 'Search contacts',
            onChangeText: (e) => setQuery(e.nativeEvent.text),
            onCancelButtonPress: () => setQuery(''),
          },
          headerRight: () => (
            <IconButton
              icon="person-add"
              accessibilityLabel="Invite someone"
              onPress={() => setInviteOpen(true)}
              size={36}
            />
          ),
        }}
      />
      <SectionList
        sections={status === 'ready' ? data : []}
        keyExtractor={(c) => c.id}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        className="bg-background"
        stickySectionHeadersEnabled
        ListHeaderComponent={
          query ? null : (
            <Pressable
              onPress={() => setInviteOpen(true)}
              accessibilityRole="button"
              className="mx-4 mb-2 mt-1 flex-row items-center gap-3 rounded-xl bg-accent/10 p-4 active:opacity-80"
            >
              <View className="h-11 w-11 items-center justify-center rounded-full bg-accent">
                <Icon name="person-add" size={20} color="accent-foreground" />
              </View>
              <View className="flex-1">
                <Text variant="headline">Invite family & friends</Text>
                <Text variant="footnote" tone="secondary">
                  Koode is invite-only. Share a personal invite.
                </Text>
              </View>
              <Icon name="chevron-right" size={14} color="text-tertiary" />
            </Pressable>
          )
        }
        renderSectionHeader={({ section }) => (
          <View className="bg-background px-4 pb-1 pt-3">
            <Text variant="footnote" tone="secondary" className="font-semibold">
              {section.title}
            </Text>
          </View>
        )}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push(`/contact/${item.id}`)}
            accessibilityRole="button"
            accessibilityLabel={`${item.displayName}, ${item.online ? 'online' : formatLastSeen(item.lastSeenAt)}`}
            className="flex-row items-center gap-3 px-4 active:bg-fill"
            style={{ height: 64 }}
          >
            <Avatar id={item.id} name={item.displayName} size={44} online={item.online} />
            <View className="h-full flex-1 justify-center border-b border-separator">
              <Text variant="headline">{item.displayName}</Text>
              <Text variant="footnote" tone={item.online ? 'accent' : 'tertiary'}>
                {item.online ? 'online' : `@${item.username}`}
              </Text>
            </View>
          </Pressable>
        )}
        ListEmptyComponent={
          status !== 'ready' ? (
            <SkeletonList rows={8} avatarSize={44} />
          ) : query ? (
            <EmptyState
              icon="search"
              title="No contacts found"
              message={`No one matches “${query}”.`}
            />
          ) : (
            <EmptyState
              icon="contacts"
              title="No contacts yet"
              message="Invite the people you want to talk to. They’ll appear here once they join."
              action={{ label: 'Send an invite', onPress: () => setInviteOpen(true) }}
            />
          )
        }
        ListFooterComponent={<View className="h-24" />}
      />

      <Sheet visible={inviteOpen} onClose={() => setInviteOpen(false)} title="Invite someone">
        <View className="gap-4 px-5 pb-2">
          <Text variant="subhead" tone="secondary" className="text-center">
            Share this code with one person. It works once and expires in 7 days.
          </Text>
          <View className="items-center rounded-xl bg-surface py-6">
            <Text
              variant="title1"
              style={{ letterSpacing: 3, fontVariant: ['tabular-nums'] }}
              selectable
            >
              {inviteCode}
            </Text>
          </View>
          <Button
            label="Share invite"
            icon="share"
            fullWidth
            onPress={async () => {
              await Share.share({
                message: `Join me on Koode, our private family chat. Invite code: ${inviteCode}`,
              });
              setInviteOpen(false);
            }}
          />
          <Button
            label="Done"
            variant="plain"
            fullWidth
            onPress={() => {
              setInviteOpen(false);
              toast.show({
                title: 'Invite ready',
                message: 'It stays valid for 7 days.',
                tone: 'success',
              });
            }}
          />
        </View>
      </Sheet>
    </>
  );
}
