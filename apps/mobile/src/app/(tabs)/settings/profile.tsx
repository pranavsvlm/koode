import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Button, ListRow, ListSection, TextField, useDialog, useToast } from '@/components/ui';
import { authErrorMessage } from '@/features/auth/errors';
import { ProfileAvatar } from '@/features/profile/ProfileAvatar';
import { removeProfilePhoto, setProfilePhoto } from '@/features/profile/upload';
import { useChat } from '@/stores/chat';
import { useSession } from '@/stores/session';

export default function ProfileScreen() {
  const user = useSession((s) => s.user);
  const updateProfile = useSession((s) => s.updateProfile);
  const toast = useToast();
  const dialog = useDialog();
  const live = useChat((s) => s.mode === 'live');
  const myPhoto = useChat((s) => s.myPhoto);
  const [photoBusy, setPhotoBusy] = useState(false);
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

  const changePhoto = async () => {
    if (!live) {
      toast.show({ title: 'Sign in to set a profile photo' });
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 1,
      exif: false,
    });
    const asset = picked.canceled ? undefined : picked.assets[0];
    if (!asset) return;
    setPhotoBusy(true);
    try {
      await setProfilePhoto(asset);
      toast.show({
        title: 'Profile photo updated',
        message: 'People see it after your next message.',
        tone: 'success',
      });
    } catch {
      toast.show({ title: 'Couldn’t update your photo', message: 'Try again.', tone: 'error' });
    } finally {
      setPhotoBusy(false);
    }
  };

  const removePhoto = async () => {
    const ok = await dialog.confirm({
      title: 'Remove your photo?',
      message: 'People will see your initials instead.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    setPhotoBusy(true);
    try {
      await removeProfilePhoto();
    } catch {
      toast.show({ title: 'Couldn’t remove your photo', message: 'Try again.', tone: 'error' });
    } finally {
      setPhotoBusy(false);
    }
  };

  return (
    <KeyboardAwareScrollView
      className="flex-1 bg-background"
      contentContainerClassName="gap-7 px-4 pb-16 pt-6"
      bottomOffset={24}
    >
      <View className="items-center gap-3">
        <ProfileAvatar id={user?.username ?? 'me'} name={name || '?'} size={112} photo={myPhoto} />
        <View className="flex-row gap-2">
          <Button
            label={myPhoto ? 'Change Photo' : 'Add Photo'}
            variant="plain"
            size="md"
            loading={photoBusy}
            onPress={() => void changePhoto()}
          />
          {myPhoto && !photoBusy && (
            <Button label="Remove" variant="plain" size="md" onPress={() => void removePhoto()} />
          )}
        </View>
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
