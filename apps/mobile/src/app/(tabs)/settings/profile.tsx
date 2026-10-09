import { useState } from 'react';
import { View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Avatar, Button, ListRow, ListSection, TextField, useToast } from '@/components/ui';
import { authErrorMessage } from '@/features/auth/errors';
import { useSession } from '@/stores/session';

export default function ProfileScreen() {
  const user = useSession((s) => s.user);
  const updateProfile = useSession((s) => s.updateProfile);
  const toast = useToast();
  const [name, setName] = useState(user?.displayName ?? '');
  const [about, setAbout] = useState(user?.about ?? '');
  const [saving, setSaving] = useState(false);
  const dirty = name.trim() !== user?.displayName || about.trim() !== (user?.about ?? '');

  const save = async () => {
    setSaving(true);
    try {
      await updateProfile({ displayName: name.trim(), about: about.trim() });
      toast.show({ title: 'Profile updated', tone: 'success' });
    } catch (e) {
      toast.show({ title: 'Couldn’t save', message: authErrorMessage(e), tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAwareScrollView
      className="flex-1 bg-background"
      contentContainerClassName="gap-7 px-4 pb-16 pt-6"
      bottomOffset={24}
    >
      <View className="items-center gap-3">
        <Avatar id={user?.username ?? 'me'} name={name || '?'} size={112} />
        <Button
          label="Change photo"
          variant="plain"
          size="md"
          onPress={() =>
            toast.show({ title: 'Profile photos arrive with media support (Phase 7)' })
          }
        />
      </View>

      <View className="gap-5">
        <TextField
          label="Name"
          value={name}
          onChangeText={setName}
          maxLength={48}
          autoComplete="name"
        />
        <TextField
          label="About"
          value={about}
          onChangeText={setAbout}
          placeholder="A short status for family and friends"
          maxLength={120}
          hint={`${about.length}/120`}
        />
      </View>

      <ListSection footer="Your username is how people find you. It can’t be changed.">
        <ListRow
          title="Username"
          accessory={{ type: 'value', value: `@${user?.username ?? ''}` }}
        />
      </ListSection>

      <Button
        label="Save"
        disabled={!dirty || name.trim().length === 0}
        loading={saving}
        fullWidth
        onPress={save}
      />
    </KeyboardAwareScrollView>
  );
}
