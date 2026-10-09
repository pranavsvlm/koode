import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Avatar, Button, Text, TextField } from '@/components/ui';
import { authClient } from '@/features/auth';
import { validateUsername } from '@/features/auth/validation';
import { useDebouncedLookup } from '@/lib/useDebouncedLookup';

const checkUsername = (u: string) => authClient.usernameAvailable(u);

export default function CreateProfileScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const formatError = validateUsername(username);
  const availability = useDebouncedLookup(
    username.length >= 3 && !formatError ? username : null,
    checkUsername,
  );
  const taken = availability.state === 'done' && !availability.value.available;
  const usernameOk = availability.state === 'done' && availability.value.available;
  const valid = name.trim().length > 0 && usernameOk;

  const hint =
    availability.state === 'checking'
      ? 'Checking…'
      : usernameOk
        ? `@${username} is available`
        : 'People can find you by your username.';

  return (
    <KeyboardAwareScrollView
      className="flex-1 bg-background"
      contentContainerClassName="flex-grow px-6 pb-8 pt-4"
      keyboardShouldPersistTaps="handled"
      bottomOffset={24}
    >
      <Text variant="large-title">Create your profile</Text>
      <Text variant="body" tone="secondary" className="mt-2">
        This is how family and friends will see you. You can change your name any time.
      </Text>

      <View className="my-8 items-center">
        <Avatar id={username || 'new'} name={name || '?'} size={104} />
      </View>

      <View className="gap-5">
        <TextField
          label="Name"
          value={name}
          onChangeText={setName}
          placeholder="Your name"
          autoComplete="name"
          textContentType="name"
          maxLength={48}
          returnKeyType="next"
        />
        <TextField
          label="Username"
          prefix="@"
          value={username}
          onChangeText={(t) => setUsername(t.toLowerCase().replace(/\s/g, ''))}
          placeholder="username"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username-new"
          textContentType="username"
          maxLength={24}
          error={
            formatError ??
            (taken ? (availability.value.reason ?? 'This username is taken') : undefined) ??
            (availability.state === 'error'
              ? 'Couldn’t check this username. Check your connection.'
              : undefined)
          }
          hint={hint}
        />
      </View>

      <View className="flex-1" />
      <Button
        label="Continue"
        disabled={!valid}
        fullWidth
        className="mt-8"
        onPress={() =>
          router.push({ pathname: '/recovery-key', params: { code, name: name.trim(), username } })
        }
      />
    </KeyboardAwareScrollView>
  );
}
