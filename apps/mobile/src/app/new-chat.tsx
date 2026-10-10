import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Avatar, Button, EmptyState, Icon, Text, TextField, useToast } from '@/components/ui';
import { authErrorMessage } from '@/features/auth/errors';
import type { Contact } from '@/domain/types';
import { haptics } from '@/lib/haptics';
import { cn } from '@/lib/cn';
import { useChat } from '@/stores/chat';
import { MotionView } from '@/components/ui/MotionView';
import { startCall } from '@/features/calls/startCall';
import { ProfileAvatar } from '@/features/profile/ProfileAvatar';

type Step = 'pick' | 'name';

export default function NewChatScreen() {
  const { mode } = useLocalSearchParams<{ mode?: 'call' }>();
  const callMode = mode === 'call';
  const contacts = useChat((s) => s.contacts);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [step, setStep] = useState<Step>('pick');
  const [groupName, setGroupName] = useState('');

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(contacts)
      .filter((c) => !q || c.displayName.toLowerCase().includes(q) || c.username.includes(q))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [contacts, query]);

  const choose = (c: Contact) => {
    if (callMode) {
      router.dismiss();
      startCall(c.id, 'voice');
      return;
    }
    if (!group) {
      void start([c.id]);
      return;
    }
    haptics.selection();
    setSelected((s) => (s.includes(c.id) ? s.filter((x) => x !== c.id) : [...s, c.id]));
  };

  const start = async (memberIds: string[], title?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const id = await useChat.getState().createConversation(memberIds, title);
      if (title) haptics.success();
      router.dismiss();
      router.push(`/chat/${id}`);
    } catch (e) {
      toast.show({
        title: 'Couldn’t start the conversation',
        message: authErrorMessage(e),
        tone: 'error',
      });
    } finally {
      setBusy(false);
    }
  };
  const createGroup = () => void start(selected, groupName.trim());

  const title = callMode
    ? 'New Call'
    : step === 'name'
      ? 'Name Group'
      : group
        ? 'New Group'
        : 'New Message';

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-background">
      <View className="h-14 flex-row items-center justify-between px-4">
        <Pressable
          onPress={() =>
            step === 'name'
              ? setStep('pick')
              : group
                ? (setGroup(false), setSelected([]))
                : router.back()
          }
          accessibilityRole="button"
          hitSlop={12}
        >
          <Text variant="body" tone="accent">
            {step === 'name' || group ? 'Back' : 'Cancel'}
          </Text>
        </Pressable>
        <Text variant="headline" accessibilityRole="header">
          {title}
        </Text>
        <View style={{ minWidth: 52 }} className="items-end">
          {group && step === 'pick' && (
            <Pressable
              onPress={() => setStep('name')}
              disabled={selected.length < 2}
              accessibilityRole="button"
              hitSlop={12}
            >
              <Text
                variant="body"
                tone={selected.length < 2 ? 'tertiary' : 'accent'}
                className="font-semibold"
              >
                Next
              </Text>
            </Pressable>
          )}
        </View>
      </View>

      {step === 'name' ? (
        <MotionView entering={FadeIn} className="flex-1 gap-6 px-5 pt-4">
          <View className="items-center">
            <Avatar id={groupName || 'new-group'} name={groupName || 'Group'} size={88} group />
          </View>
          <TextField
            label="Group name"
            value={groupName}
            onChangeText={setGroupName}
            placeholder="e.g. Cousins"
            autoFocus
            maxLength={48}
          />
          <View className="flex-row flex-wrap gap-2">
            {selected.map((sid) => (
              <View
                key={sid}
                className="flex-row items-center gap-1.5 rounded-full bg-fill py-1 pl-1 pr-3"
              >
                <ProfileAvatar
                  id={sid}
                  name={contacts[sid]?.displayName ?? ''}
                  size={24}
                  photo={contacts[sid]?.photo}
                />
                <Text variant="footnote">{contacts[sid]?.displayName.split(' ')[0]}</Text>
              </View>
            ))}
          </View>
          <View className="flex-1" />
          <Button
            label="Create Group"
            loading={busy}
            disabled={!groupName.trim()}
            onPress={createGroup}
            fullWidth
            className="mb-2"
          />
        </MotionView>
      ) : (
        <>
          <View className="px-4 pb-2">
            <TextField
              icon="search"
              value={query}
              onChangeText={setQuery}
              placeholder="Search"
              autoCorrect={false}
              accessibilityLabel="Search contacts"
            />
          </View>
          {group && selected.length > 0 && (
            <Animated.View entering={FadeIn} exiting={FadeOut}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerClassName="gap-3 px-4 py-2"
              >
                {selected.map((sid) => (
                  <MotionView
                    key={sid}
                    layout={LinearTransition}
                    entering={FadeIn}
                    className="items-center gap-1"
                    style={{ width: 56 }}
                  >
                    <ProfileAvatar
                      id={sid}
                      name={contacts[sid]?.displayName ?? ''}
                      size={48}
                      photo={contacts[sid]?.photo}
                    />
                    <Text variant="caption" numberOfLines={1}>
                      {contacts[sid]?.displayName.split(' ')[0]}
                    </Text>
                  </MotionView>
                ))}
              </ScrollView>
            </Animated.View>
          )}
          <FlatList
            data={list}
            keyExtractor={(c) => c.id}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            ListHeaderComponent={
              !group && !callMode && !query ? (
                <Pressable
                  onPress={() => setGroup(true)}
                  accessibilityRole="button"
                  className="flex-row items-center gap-3 px-4 active:bg-fill"
                  style={{ height: 60 }}
                >
                  <View className="h-11 w-11 items-center justify-center rounded-full bg-accent/10">
                    <Icon name="group" size={20} color="accent" />
                  </View>
                  <Text variant="body" tone="accent" className="font-semibold">
                    New Group
                  </Text>
                </Pressable>
              ) : null
            }
            renderItem={({ item }) => {
              const isSelected = selected.includes(item.id);
              return (
                <Pressable
                  onPress={() => choose(item)}
                  accessibilityRole={group ? 'checkbox' : 'button'}
                  accessibilityState={group ? { checked: isSelected } : undefined}
                  accessibilityLabel={item.displayName}
                  className="flex-row items-center gap-3 px-4 active:bg-fill"
                  style={{ height: 60 }}
                >
                  <ProfileAvatar
                    id={item.id}
                    name={item.displayName}
                    size={44}
                    online={item.online}
                    photo={item.photo}
                  />
                  <View className="flex-1">
                    <Text variant="headline">{item.displayName}</Text>
                    <Text variant="footnote" tone="tertiary">
                      @{item.username}
                    </Text>
                  </View>
                  {group && (
                    <View
                      className={cn(
                        'h-6 w-6 items-center justify-center rounded-full',
                        isSelected ? 'bg-accent' : 'border-2 border-text-tertiary/60',
                      )}
                    >
                      {isSelected && (
                        <Icon name="check" size={13} color="accent-foreground" weight="bold" />
                      )}
                    </View>
                  )}
                  {callMode && <Icon name="phone" size={18} color="accent" />}
                </Pressable>
              );
            }}
            ListEmptyComponent={<EmptyState icon="search" title="No contacts found" />}
          />
        </>
      )}
    </SafeAreaView>
  );
}
