import { useState } from 'react';
import { View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Avatar, Button, ListRow, ListSection, Text, TextField, useToast } from '@/components/ui';
import { useSession } from '@/stores/session';

export default function ProfileScreen() {
  const profile = useSession((s) => s.profile);
  const updateProfile = useSession((s) => s.updateProfile);
  const toast = useToast();
  const [name, setName] = useState(profile?.displayName ?? '');
  const [about, setAbout] = useState(profile?.about ?? '');
  const dirty = name.trim() !== profile?.displayName || about.trim() !== (profile?.about ?? '');

  return (
    <KeyboardAwareScrollView
      className="flex-1 bg-background"
      contentContainerClassName="gap-7 px-4 pb-16 pt-6"
      bottomOffset={24}
    >
      <View className="items-center gap-3">
        <Avatar id={profile?.username ?? 'me'} name={name || '?'} size={112} />
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

      <ListSection footer="Your username is how people find you. It can’t be changed in this build.">
        <ListRow
          title="Username"
          accessory={{ type: 'value', value: `@${profile?.username ?? ''}` }}
        />
      </ListSection>

      <Button
        label="Save"
        disabled={!dirty || name.trim().length === 0}
        fullWidth
        onPress={() => {
          updateProfile({ displayName: name.trim(), about: about.trim() });
          toast.show({ title: 'Profile updated', tone: 'success' });
        }}
      />
      <Text variant="footnote" tone="tertiary" className="text-center">
        Stored on this device only until accounts arrive in Phase 3.
      </Text>
    </KeyboardAwareScrollView>
  );
}
