import * as Crypto from 'expo-crypto';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Button, Icon, Text, useToast } from '@/components/ui';
import { authErrorMessage } from '@/features/auth/errors';
import { Checkbox, RecoveryKeyCard } from '@/features/auth/RecoveryKeyCard';
import { generateRecoveryKey } from '@/features/auth/validation';
import { ApiClientError } from '@/lib/api';
import { haptics } from '@/lib/haptics';
import { useSession } from '@/stores/session';

export default function RecoveryKeyScreen() {
  const { code, name, username } = useLocalSearchParams<{
    code: string;
    name: string;
    username: string;
  }>();
  const toast = useToast();
  const register = useSession((s) => s.register);
  // Generated on this device; the server stores only a hash of it.
  const [key] = useState(() => generateRecoveryKey(Crypto.getRandomBytes));
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const finish = async () => {
    setBusy(true);
    try {
      await register({ inviteCode: code, username, displayName: name, recoveryKey: key });
      haptics.success();
      // Signed in: the root navigator switches to the app on its own.
    } catch (e) {
      toast.show({
        title: 'Couldn’t create your account',
        message: authErrorMessage(e),
        tone: 'error',
      });
      if (e instanceof ApiClientError && e.code === 'conflict') router.back(); // username taken
      if (e instanceof ApiClientError && e.code === 'forbidden') router.dismissTo('/invite'); // invite gone
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="flex-grow px-6 pb-8 pt-4"
    >
      <View className="h-16 w-16 items-center justify-center rounded-[20px] bg-accent/10">
        <Icon name="key" size={30} color="accent" />
      </View>
      <Text variant="large-title" className="mt-5">
        Save your recovery key
      </Text>
      <Text variant="body" tone="secondary" className="mb-8 mt-2">
        If you lose this phone, this key is the only way to get your account back. Keep it somewhere
        safe, like a password manager. Koode can’t recover it for you.
      </Text>

      <RecoveryKeyCard recoveryKey={key} />

      <View className="flex-1" />
      <View className="mb-4 mt-8">
        <Checkbox
          checked={saved}
          onChange={setSaved}
          label="I’ve saved my recovery key somewhere safe"
        />
      </View>
      <Button label="Create Account" disabled={!saved} loading={busy} fullWidth onPress={finish} />
    </ScrollView>
  );
}
