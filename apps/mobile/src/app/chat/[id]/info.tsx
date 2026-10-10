import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import {
  Avatar,
  Button,
  ListRow,
  ListSection,
  Sheet,
  Text,
  TextField,
  useDialog,
  useToast,
} from '@/components/ui';
import { ME } from '@/domain/types';
import { detailOptions } from '@/navigation/options';
import { conversationTitle, useChat } from '@/stores/chat';
import { useSession } from '@/stores/session';
import { useThemeColors } from '@/theme/ThemeProvider';
import type { Contact } from '@/domain/types';
import { ProfileAvatar } from '@/features/profile/ProfileAvatar';

const MAX_MEMBERS = 64;

export default function GroupInfoScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useThemeColors();
  const toast = useToast();
  const dialog = useDialog();
  const conversation = useChat((s) => s.conversations[id]);
  const contacts = useChat((s) => s.contacts);
  const myPhoto = useChat((s) => s.myPhoto);
  const live = useChat((s) => s.mode === 'live');
  const { setMuted, renameGroup, addMembers, removeMember, setAdmin, leaveGroup } =
    useChat.getState();
  const me = useSession((s) => s.user);

  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [member, setMember] = useState<string | null>(null);

  if (!conversation) return null;
  const title = conversationTitle(conversation, contacts);
  const iAmAdmin = conversation.adminIds.includes(ME);
  const nameOf = (userId: string) => contacts[userId]?.displayName ?? 'Unknown';

  /** Run a group change; the server records it as a message in the chat. */
  const run = async (what: string, fn: () => Promise<void>) => {
    if (!live) {
      toast.show({ title: 'Turn off sample data to change real groups' });
      return false;
    }
    try {
      await fn();
      return true;
    } catch (e) {
      toast.show({
        title: `Couldn’t ${what}`,
        message: e instanceof Error ? e.message : undefined,
        tone: 'error',
      });
      return false;
    }
  };

  const memberIsAdmin = member ? conversation.adminIds.includes(member) : false;

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
        {iAmAdmin && conversation.memberIds.length < MAX_MEMBERS && (
          <ListRow icon="person-add" title="Add Members" onPress={() => setAdding(true)} />
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
                <ProfileAvatar
                  id={isMe ? (me?.username ?? 'me') : memberId}
                  name={isMe ? (me?.displayName ?? 'You') : name}
                  size={32}
                  photo={isMe ? myPhoto : contacts[memberId]?.photo}
                />
              }
              title={name}
              subtitle={contact?.about}
              accessory={
                conversation.adminIds.includes(memberId)
                  ? { type: 'value', value: 'Admin' }
                  : { type: 'none' }
              }
              onPress={isMe ? undefined : () => setMember(memberId)}
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
            onPress={() => setRenaming(true)}
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
              message:
                'You won’t receive new messages from this group, and its messages and files will no longer be available to you.',
              confirmLabel: 'Leave',
              destructive: true,
            });
            if (ok && (await run('leave the group', () => leaveGroup(id))))
              router.dismissTo('/chats');
          }}
        />
      </ListSection>

      <RenameSheet
        visible={renaming}
        current={conversation.title ?? ''}
        onClose={() => setRenaming(false)}
        onSave={async (name) => {
          if (await run('rename the group', () => renameGroup(id, name))) setRenaming(false);
        }}
      />

      <AddMembersSheet
        visible={adding}
        candidates={Object.values(contacts)
          .filter((c) => !conversation.memberIds.includes(c.id))
          .sort((a, b) => a.displayName.localeCompare(b.displayName))}
        room={MAX_MEMBERS - conversation.memberIds.length}
        onClose={() => setAdding(false)}
        onAdd={async (ids) => {
          if (await run('add people', () => addMembers(id, ids))) setAdding(false);
        }}
      />

      <Sheet
        visible={!!member}
        onClose={() => setMember(null)}
        title={member ? nameOf(member) : ''}
      >
        {member && (
          <View className="px-4 pb-2">
            <View className="overflow-hidden rounded-xl bg-surface">
              <ListRow
                icon="person"
                title="View Contact"
                onPress={() => {
                  const target = member;
                  setMember(null);
                  router.push(`/contact/${target}`);
                }}
              />
              {iAmAdmin && (
                <ListRow
                  icon="shield"
                  title={memberIsAdmin ? 'Remove as Admin' : 'Make Group Admin'}
                  onPress={async () => {
                    const target = member;
                    setMember(null);
                    await run('change the admin', () => setAdmin(id, target, !memberIsAdmin));
                  }}
                />
              )}
              {iAmAdmin && (
                <ListRow
                  title="Remove from Group"
                  destructive
                  onPress={async () => {
                    const target = member;
                    setMember(null);
                    const ok = await dialog.confirm({
                      title: `Remove ${nameOf(target)}?`,
                      message:
                        'They won’t see new messages, and lose access to this group’s messages and files.',
                      confirmLabel: 'Remove',
                      destructive: true,
                    });
                    if (ok) await run('remove them', () => removeMember(id, target));
                  }}
                />
              )}
            </View>
          </View>
        )}
      </Sheet>
    </ScrollView>
  );
}

function RenameSheet(p: {
  visible: boolean;
  current: string;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(p.current);
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();
  return (
    <Sheet visible={p.visible} onClose={p.onClose} title="Group Name">
      <View className="gap-4 px-4 pb-2">
        <TextField
          value={name}
          onChangeText={setName}
          maxLength={64}
          autoFocus
          accessibilityLabel="Group name"
          returnKeyType="done"
        />
        <Button
          label="Save"
          fullWidth
          loading={busy}
          disabled={!trimmed || trimmed === p.current}
          onPress={async () => {
            setBusy(true);
            await p.onSave(trimmed);
            setBusy(false);
          }}
        />
      </View>
    </Sheet>
  );
}

function AddMembersSheet(p: {
  visible: boolean;
  candidates: Contact[];
  room: number;
  onClose: () => void;
  onAdd: (ids: string[]) => Promise<void>;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) =>
    setPicked((list) =>
      list.includes(id)
        ? list.filter((x) => x !== id)
        : list.length < p.room
          ? [...list, id]
          : list,
    );
  return (
    <Sheet visible={p.visible} onClose={p.onClose} title="Add Members">
      <View className="gap-4 px-4 pb-2">
        {p.candidates.length === 0 ? (
          <Text variant="subhead" tone="secondary" className="text-center">
            Everyone you know on Koode is already in this group.
          </Text>
        ) : (
          <ScrollView style={{ maxHeight: 360 }} className="rounded-xl bg-surface">
            {p.candidates.map((c) => (
              <ListRow
                key={c.id}
                leading={<ProfileAvatar id={c.id} name={c.displayName} size={32} photo={c.photo} />}
                title={c.displayName}
                subtitle={`@${c.username}`}
                accessory={{ type: 'check', checked: picked.includes(c.id) }}
                onPress={() => toggle(c.id)}
              />
            ))}
          </ScrollView>
        )}
        <Button
          label={picked.length > 1 ? `Add ${picked.length} People` : 'Add'}
          fullWidth
          loading={busy}
          disabled={picked.length === 0}
          onPress={async () => {
            setBusy(true);
            await p.onAdd(picked);
            setBusy(false);
            setPicked([]);
          }}
        />
      </View>
    </Sheet>
  );
}
