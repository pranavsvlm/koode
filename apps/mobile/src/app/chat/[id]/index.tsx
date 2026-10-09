import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { Avatar, Button, EmptyState, IconButton, Text, useToast } from '@/components/ui';
import { ME, type Message } from '@/domain/types';
import { ChatHeaderTitle } from '@/features/chat/ChatHeaderTitle';
import { Composer } from '@/features/chat/Composer';
import { DayDivider } from '@/features/chat/DayDivider';
import { buildChatItems, type ChatItem } from '@/features/chat/items';
import { MessageActionsSheet } from '@/features/chat/MessageActionsSheet';
import { MessageBubble } from '@/features/chat/MessageBubble';
import { TypingIndicator } from '@/features/chat/TypingIndicator';
import { detailOptions } from '@/navigation/options';
import { conversationTitle, directContactId, useChat } from '@/stores/chat';
import { usePreferences } from '@/stores/preferences';
import { useThemeColors } from '@/theme/ThemeProvider';
import { startCall } from '@/features/calls/startCall';

const EMPTY: Message[] = [];

export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useThemeColors();
  const toast = useToast();
  const conversation = useChat((s) => s.conversations[id]);
  const messages = useChat((s) => s.messages[id] ?? EMPTY);
  const contacts = useChat((s) => s.contacts);
  const hasMore = useChat((s) => s.hasMore[id] ?? false);
  const { send, toggleReaction, deleteMessage, markRead } = useChat.getState();
  const textSize = usePreferences((s) => s.chatTextSize);
  const showTyping = usePreferences((s) => s.typingIndicators);

  const [replyTo, setReplyTo] = useState<Message | undefined>();
  const [actionMessage, setActionMessage] = useState<Message | null>(null);
  // Messages newer than this animate in; older ones render statically.
  const [openedAt] = useState(() => Date.now());

  const isGroup = conversation?.kind === 'group';
  const items = useMemo(() => buildChatItems(messages, isGroup), [messages, isGroup]);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  useEffect(() => {
    markRead(id);
  }, [id, messages.length, markRead]);

  const nameOf = useCallback(
    (userId: string) => (userId === ME ? 'You' : (contacts[userId]?.displayName ?? 'Unknown')),
    [contacts],
  );

  const onOpenMedia = useCallback(
    (m: Message) =>
      router.push({ pathname: '/media/[id]', params: { id: m.id, conversationId: id } }),
    [id],
  );
  const onReact = useCallback(
    (m: Message, emoji: string) => toggleReaction(id, m.id, emoji),
    [id, toggleReaction],
  );
  const onOpenDocument = useCallback(
    () => toast.show({ title: 'Downloads arrive with media support (Phase 7)' }),
    [toast],
  );
  const onRetry = useCallback((m: Message) => useChat.getState().retry(m.id), []);

  const renderItem = useCallback(
    ({ item }: { item: ChatItem }) => {
      if (item.type === 'day') return <DayDivider label={item.label} />;
      const m = item.message;
      const replyTarget = m.replyToId ? byId.get(m.replyToId) : undefined;
      return (
        <MessageBubble
          message={m}
          position={item.position}
          sender={contacts[m.senderId]}
          showSender={item.showSender}
          showAvatar={item.showAvatar}
          isGroup={isGroup}
          replyTo={replyTarget}
          replyToName={replyTarget ? nameOf(replyTarget.senderId) : undefined}
          textSize={textSize}
          isNew={m.createdAt > openedAt}
          onLongPress={setActionMessage}
          onReply={setReplyTo}
          onOpenMedia={onOpenMedia}
          onToggleReaction={onReact}
          onOpenDocument={onOpenDocument}
          onRetry={onRetry}
        />
      );
    },
    [
      byId,
      contacts,
      isGroup,
      nameOf,
      textSize,
      openedAt,
      onOpenMedia,
      onReact,
      onOpenDocument,
      onRetry,
    ],
  );

  if (!conversation) {
    return (
      <View className="flex-1 bg-background">
        <Stack.Screen options={{ ...detailOptions(colors), title: '' }} />
        <EmptyState
          icon="chats"
          title="Conversation not found"
          action={{ label: 'Back to chats', onPress: () => router.back() }}
        />
      </View>
    );
  }

  const title = conversationTitle(conversation, contacts);
  const otherId = directContactId(conversation);
  const typingId = showTyping ? conversation.typingUserIds[0] : undefined;

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen
        options={{
          ...detailOptions(colors),
          headerTitle: () => (
            <ChatHeaderTitle
              conversation={conversation}
              title={title}
              contacts={contacts}
              showTyping={showTyping}
              onPress={() =>
                otherId ? router.push(`/contact/${otherId}`) : router.push(`/chat/${id}/info`)
              }
            />
          ),
          headerRight: () =>
            otherId ? (
              <View className="flex-row">
                <IconButton
                  icon="video"
                  accessibilityLabel={`Video call ${title}`}
                  onPress={() => startCall(otherId, 'video')}
                  size={38}
                />
                <IconButton
                  icon="phone"
                  accessibilityLabel={`Call ${title}`}
                  onPress={() => startCall(otherId, 'voice')}
                  size={38}
                />
              </View>
            ) : (
              <IconButton
                icon="info"
                accessibilityLabel="Group info"
                onPress={() => router.push(`/chat/${id}/info`)}
                size={38}
              />
            ),
        }}
      />
      <KeyboardAvoidingView behavior="padding" className="flex-1">
        {items.length === 0 ? (
          <View className="flex-1 items-center justify-center gap-3 px-10">
            <Avatar id={otherId ?? id} name={title} size={88} group={isGroup} />
            <Text variant="title3" className="text-center">
              {title}
            </Text>
            <Text variant="subhead" tone="secondary" className="text-center">
              This is the beginning of your conversation.
            </Text>
            <Button
              label="Say hello 👋"
              variant="secondary"
              size="md"
              onPress={() => send(id, { text: 'Hello! 👋' })}
            />
          </View>
        ) : (
          <FlatList
            data={items}
            inverted
            keyExtractor={(item) => item.key}
            renderItem={renderItem}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            contentContainerClassName="pb-2 pt-2"
            initialNumToRender={20}
            maxToRenderPerBatch={12}
            windowSize={11}
            onEndReached={() => {
              if (hasMore) void useChat.getState().loadOlder(id);
            }}
            onEndReachedThreshold={0.4}
            // Inverted list: the footer sits above the oldest message.
            ListFooterComponent={
              hasMore ? (
                <ActivityIndicator className="py-4" color={colors['text-tertiary']} />
              ) : null
            }
            ListHeaderComponent={
              typingId ? (
                <TypingIndicator name={isGroup ? contacts[typingId]?.displayName : undefined} />
              ) : null
            }
            accessibilityLabel="Messages"
          />
        )}
        <Composer
          replyTo={replyTo}
          replyToName={replyTo ? nameOf(replyTo.senderId) : undefined}
          onCancelReply={() => setReplyTo(undefined)}
          onSend={(text) => {
            send(id, { text, replyToId: replyTo?.id });
            setReplyTo(undefined);
          }}
          onTyping={() => useChat.getState().typing(id)}
          onAttach={() => router.push({ pathname: '/attach', params: { conversationId: id } })}
          onVoice={() =>
            toast.show({ title: 'Voice messages arrive with media support (Phase 7)' })
          }
        />
      </KeyboardAvoidingView>

      <MessageActionsSheet
        message={actionMessage}
        onClose={() => setActionMessage(null)}
        onReply={setReplyTo}
        onReact={onReact}
        onDelete={(m) => deleteMessage(id, m.id)}
      />
    </View>
  );
}
