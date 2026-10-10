import { router, Stack } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import {
  EmptyState,
  Icon,
  IconButton,
  SegmentedControl,
  SkeletonList,
  Text,
} from '@/components/ui';
import type { CallRecord } from '@/domain/types';
import { formatCallLength, formatConversationTime } from '@/lib/format';
import { useChat } from '@/stores/chat';
import { startCall } from '@/features/calls/startCall';
import { ProfileAvatar } from '@/features/profile/ProfileAvatar';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'missed', label: 'Missed' },
] as const;

function describe(call: CallRecord): string {
  const kind = call.kind === 'video' ? 'video' : 'voice';
  switch (call.outcome) {
    case 'missed':
      return `Missed ${kind} call`;
    case 'declined':
      return `Declined ${kind} call`;
    case 'cancelled':
      return `Cancelled ${kind} call`;
    default:
      return `${call.direction === 'incoming' ? 'Incoming' : 'Outgoing'} ${kind} · ${formatCallLength(call.durationSec)}`;
  }
}

export default function CallsScreen() {
  const status = useChat((s) => s.status);
  const calls = useChat((s) => s.calls);
  const contacts = useChat((s) => s.contacts);
  const [filter, setFilter] = useState<'all' | 'missed'>('all');
  const data = useMemo(
    () => (filter === 'missed' ? calls.filter((c) => c.outcome === 'missed') : calls),
    [calls, filter],
  );

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <IconButton
              icon="person-add"
              accessibilityLabel="Start a call"
              onPress={() => router.push({ pathname: '/new-chat', params: { mode: 'call' } })}
              size={36}
            />
          ),
        }}
      />
      <FlatList
        data={status === 'ready' ? data : []}
        keyExtractor={(c) => c.id}
        contentInsetAdjustmentBehavior="automatic"
        className="bg-background"
        ListHeaderComponent={
          <SegmentedControl
            options={FILTERS}
            value={filter}
            onChange={setFilter}
            className="mx-4 mb-2 mt-1"
            accessibilityLabel="Filter calls"
          />
        }
        renderItem={({ item }) => {
          const contact = contacts[item.contactId];
          if (!contact) return null;
          const missed = item.outcome === 'missed';
          const icon =
            item.outcome === 'missed'
              ? 'missed-call'
              : item.direction === 'incoming'
                ? 'incoming-call'
                : 'outgoing-call';
          return (
            <View className="flex-row items-center gap-3 pl-4">
              <Pressable
                onPress={() => startCall(contact.id, item.kind)}
                accessibilityRole="button"
                accessibilityLabel={`${contact.displayName}, ${describe(item)}, ${formatConversationTime(item.startedAt)}. Double tap to call back.`}
                className="flex-1 flex-row items-center gap-3 active:opacity-70"
                style={{ height: 68 }}
              >
                <ProfileAvatar
                  id={contact.id}
                  name={contact.displayName}
                  size={44}
                  photo={contact.photo}
                />
                <View className="h-full flex-1 justify-center border-b border-separator">
                  <Text variant="headline" tone={missed ? 'danger' : 'primary'} numberOfLines={1}>
                    {contact.displayName}
                  </Text>
                  <View className="flex-row items-center gap-1">
                    <Icon name={icon} size={12} color={missed ? 'danger' : 'text-tertiary'} />
                    <Text variant="footnote" tone="secondary" numberOfLines={1}>
                      {describe(item)}
                    </Text>
                  </View>
                </View>
              </Pressable>
              <View className="h-[68px] flex-row items-center gap-1 border-b border-separator pr-2">
                <Text variant="footnote" tone="tertiary">
                  {formatConversationTime(item.startedAt)}
                </Text>
                <IconButton
                  icon="info"
                  accessibilityLabel={`${contact.displayName} details`}
                  onPress={() => router.push(`/contact/${contact.id}`)}
                  size={40}
                />
              </View>
            </View>
          );
        }}
        ListEmptyComponent={
          status !== 'ready' ? (
            <SkeletonList rows={8} avatarSize={44} />
          ) : (
            <EmptyState
              icon="calls"
              title={filter === 'missed' ? 'No missed calls' : 'No recent calls'}
              message={
                filter === 'missed'
                  ? 'You’re all caught up.'
                  : 'Voice and video calls you make or receive will appear here.'
              }
            />
          )
        }
        ListFooterComponent={<View className="h-24" />}
      />
    </>
  );
}
