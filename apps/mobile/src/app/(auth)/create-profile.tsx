import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Avatar, Button, Text, TextField } from '@/components/ui';
import { validateUsername } from '@/features/auth/validation';

export default function CreateProfileScreen() {
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const usernameError = validateUsername(username);
  const valid = name.trim().length > 0 && username.length >= 3 && !usernameError;

  return (
    <KeyboardAwareScrollView
      className="flex-1 bg-background"
      contentContainerClassName="flex-grow px-6 pb-8 pt-4"
      keyboardShouldPersistTaps="handled"
      bottomOffset={24}
    >
      <Text variant="large-title">Create your profile</Text>
      <Text variant="body" tone="secondary" className="mt-2">
        This is how family and friends will see you. You can change it any time.
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
          error={usernameError}
          hint="People can find you by your username."
        />
      </View>

      <View className="flex-1" />
      <Button
        label="Continue"
        disabled={!valid}
        fullWidth
        className="mt-8"
        onPress={() =>
          router.push({ pathname: '/recovery-key', params: { name: name.trim(), username } })
        }
      />
    </KeyboardAwareScrollView>
  );
}
