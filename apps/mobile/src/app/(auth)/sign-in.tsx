import { useState } from 'react';
import { View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Button, ListRow, ListSection, Text, TextField, useToast } from '@/components/ui';
import { authErrorMessage } from '@/features/auth/errors';
import { validateUsername } from '@/features/auth/validation';
import { haptics } from '@/lib/haptics';
import { useSession } from '@/stores/session';

export default function SignInScreen() {
  const toast = useToast();
  const recover = useSession((s) => s.recover);
  const [username, setUsername] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const normalized = key.toUpperCase().replace(/[^0-9A-Z]/g, '');
  const valid = username.length >= 3 && !validateUsername(username) && normalized.length === 24;

  const restore = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await recover({ username, recoveryKey: normalized });
      haptics.success();
    } catch (e) {
      setError(authErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAwareScrollView
      className="flex-1 bg-background"
      contentContainerClassName="flex-grow px-6 pb-8 pt-4"
      keyboardShouldPersistTaps="handled"
      bottomOffset={24}
    >
      <Text variant="large-title">Welcome back</Text>
      <Text variant="body" tone="secondary" className="mt-2">
        Restore your account on this phone with your username and recovery key.
      </Text>

      <View className="mt-8 gap-5">
        <TextField
          label="Username"
          prefix="@"
          value={username}
          onChangeText={(t) => setUsername(t.toLowerCase().replace(/\s/g, ''))}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username"
          textContentType="username"
          maxLength={24}
        />
        <TextField
          label="Recovery key"
          value={key}
          onChangeText={setKey}
          placeholder="XXXX XXXX XXXX XXXX XXXX XXXX"
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="off"
          hint="24 characters. Spaces don’t matter."
          error={error}
        />
      </View>

      <ListSection className="mt-8">
        <ListRow
          icon="qr"
          title="Link from another device"
          subtitle="Scan a code shown on your other phone"
          accessory={{ type: 'chevron' }}
          onPress={() => toast.show({ title: 'Device linking isn’t available yet' })}
        />
      </ListSection>

      <View className="flex-1" />
      <Button
        label="Restore Account"
        disabled={!valid}
        loading={busy}
        fullWidth
        className="mt-8"
        onPress={restore}
      />
    </KeyboardAwareScrollView>
  );
}
