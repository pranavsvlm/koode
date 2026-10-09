import { router, Stack } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';
import { EmptyState, IconButton, SkeletonList } from '@/components/ui';
import { ConversationRow } from '@/features/chat/ConversationRow';
import {
  messagePreview,
  summarizeConversations,
  useChat,
  type ConversationSummary,
} from '@/stores/chat';

export default function ChatsScreen() {
  const status = useChat((s) => s.status);
  const conversations = useChat((s) => s.conversations);
  const messages = useChat((s) => s.messages);
  const contacts = useChat((s) => s.contacts);
  const connection = useChat((s) => s.connection);
  const mode = useChat((s) => s.mode);
  const [query, setQuery] = useState('');

  const summaries = useMemo(
    () => summarizeConversations(conversations, messages, contacts),
    [conversations, messages, contacts],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return summaries;
    return summaries.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        messagePreview(s.lastMessage).toLowerCase().includes(q),
    );
  }, [summaries, query]);

  const open = useCallback((id: string) => router.push(`/chat/${id}`), []);
  const renderItem = useCallback(
    ({ item }: { item: ConversationSummary }) => (
      <ConversationRow summary={item} contacts={contacts} onPress={open} />
    ),
    [contacts, open],
  );

  return (
    <>
      <Stack.Screen
        options={{
          // Telegram-style status in the title while not connected.
          title:
            mode === 'sample' || connection === 'online'
              ? 'Chats'
              : connection === 'connecting'
                ? 'Connecting…'
                : 'Waiting for network…',
          headerSearchBarOptions: {
            placeholder: 'Search',
            hideWhenScrolling: true,
            onChangeText: (e) => setQuery(e.nativeEvent.text),
            onCancelButtonPress: () => setQuery(''),
          },
          headerRight: () => (
            <IconButton
              icon="compose"
              accessibilityLabel="New message"
              onPress={() => router.push('/new-chat')}
              size={36}
            />
          ),
        }}
      />
      <FlatList
        data={status === 'ready' ? filtered : []}
        keyExtractor={(s) => s.conversation.id}
        renderItem={renderItem}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        className="bg-background"
        getItemLayout={(_, index) => ({ length: 76, offset: 76 * index, index })}
        ListEmptyComponent={
          status !== 'ready' ? (
            <SkeletonList rows={9} avatarSize={56} />
          ) : query ? (
            <EmptyState icon="search" title="No results" message={`Nothing matches “${query}”.`} />
          ) : (
            <EmptyState
              icon="chats"
              title="No conversations yet"
              message="Start a chat with family and friends you’ve invited."
              action={{ label: 'Start a chat', onPress: () => router.push('/new-chat') }}
            />
          )
        }
        ListFooterComponent={<View className="h-24" />}
      />
    </>
  );
}
