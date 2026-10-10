import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { Button, EmptyState, IconButton, Text, useToast } from '@/components/ui';
import { ME, type Message } from '@/domain/types';
import { ChatHeaderTitle } from '@/features/chat/ChatHeaderTitle';
import { Composer } from '@/features/chat/Composer';
import { DayDivider } from '@/features/chat/DayDivider';
import { buildChatItems, type ChatItem } from '@/features/chat/items';
import { MessageActionsSheet } from '@/features/chat/MessageActionsSheet';
import { MessageBubble } from '@/features/chat/MessageBubble';
import { SystemNote } from '@/features/chat/SystemNote';
import { TypingIndicator } from '@/features/chat/TypingIndicator';
import { callController } from '@/features/calls';
import { MediaActionError, saveToPhotos, shareFile } from '@/features/media/actions';
import { MediaError, prepareVoice } from '@/features/media/process';
import type { Recording } from '@/features/media/useVoiceRecorder';
import { detailOptions } from '@/navigation/options';
import { conversationTitle, directContactId, useChat } from '@/stores/chat';
import { usePreferences } from '@/stores/preferences';
import { useThemeColors } from '@/theme/ThemeProvider';
import { startCall } from '@/features/calls/startCall';
import { setViewingConversation } from '@/features/notifications';
import { ProfileAvatar } from '@/features/profile/ProfileAvatar';

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

  // No banners for the conversation on screen; clear the ones already shown.
  useFocusEffect(
    useCallback(() => {
      setViewingConversation(id);
      return () => setViewingConversation(null);
    }, [id]),
  );

  const nameOf = useCallback(
    (userId: string) => (userId === ME ? 'You' : (contacts[userId]?.displayName ?? 'Unknown')),
    [contacts],
  );

  const onOpenMedia = useCallback(
    (m: Message) =>
      router.push({ pathname: '/media/[id]', params: { id: m.id, conversationId: id } }),
    [id],
  );
  const failed = useCallback(
    (title: string) => (e: unknown) =>
      toast.show({
        title,
        message: e instanceof MediaActionError ? e.message : 'Check your connection and try again.',
        tone: 'error',
      }),
    [toast],
  );
  const onReact = useCallback(
    (m: Message, emoji: string) =>
      void toggleReaction(id, m.id, emoji).catch(failed('Couldn’t react')),
    [id, toggleReaction, failed],
  );
  const onOpenDocument = useCallback(
    (m: Message) => {
      if (!m.attachment) return;
      toast.show({ title: 'Opening…' });
      void shareFile(m.attachment).catch(failed('Couldn’t open the file'));
    },
    [toast, failed],
  );
  const onSave = useCallback(
    (m: Message) =>
      m.attachment &&
      void saveToPhotos(m.attachment)
        .then(() => toast.show({ title: 'Saved to Photos', tone: 'success' }))
        .catch(failed('Couldn’t save')),
    [toast, failed],
  );
  const onShare = useCallback(
    (m: Message) => m.attachment && void shareFile(m.attachment).catch(failed('Couldn’t share')),
    [failed],
  );
  const onDelete = useCallback(
    (m: Message, scope: 'me' | 'everyone') =>
      void deleteMessage(id, m.id, scope).catch(failed('Couldn’t delete')),
    [id, deleteMessage, failed],
  );
  const sendVoice = useCallback(
    async (recording: Recording) => {
      try {
        const upload = await prepareVoice(recording);
        send(id, { upload, replyToId: replyTo?.id });
        setReplyTo(undefined);
      } catch (e) {
        failed('Couldn’t send the recording')(
          e instanceof MediaError ? new MediaActionError(e.message) : e,
        );
      }
    },
    [id, send, replyTo, failed],
  );
  const onRetry = useCallback((m: Message) => useChat.getState().retry(m.id), []);

  const renderItem = useCallback(
    ({ item }: { item: ChatItem }) => {
      if (item.type === 'day') return <DayDivider label={item.label} />;
      if (item.type === 'system') return <SystemNote text={item.text} />;
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
      {/* automaticOffset: measure the real position below the header. Without it
          the padding comes up short by the header's height and the keyboard
          covers the composer. */}
      <KeyboardAvoidingView behavior="padding" automaticOffset className="flex-1">
        {items.length === 0 ? (
          <View className="flex-1 items-center justify-center gap-3 px-10">
            <ProfileAvatar
              id={otherId ?? id}
              name={title}
              size={88}
              group={isGroup}
              photo={!isGroup && otherId ? contacts[otherId]?.photo : undefined}
            />
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
          onVoice={(r) => void sendVoice(r)}
          canRecord={() =>
            callController.getSnapshot().phase === 'idle' ||
            callController.getSnapshot().phase === 'ended'
              ? null
              : 'You can’t record a voice message during a call.'
          }
          onError={(message) => toast.show({ title: message, tone: 'error' })}
        />
      </KeyboardAvoidingView>

      <MessageActionsSheet
        message={actionMessage}
        canDeleteForEveryone={
          !!actionMessage &&
          (actionMessage.senderId === ME ||
            (isGroup && conversation.adminIds.includes(ME) && useChat.getState().mode === 'live'))
        }
        onClose={() => setActionMessage(null)}
        onReply={setReplyTo}
        onReact={onReact}
        onDelete={onDelete}
        onSave={onSave}
        onShare={onShare}
      />
    </View>
  );
}
