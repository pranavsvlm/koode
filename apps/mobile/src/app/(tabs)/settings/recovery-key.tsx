import * as Crypto from 'expo-crypto';
import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Button, Text, useToast } from '@/components/ui';
import { authClient } from '@/features/auth';
import { authErrorMessage } from '@/features/auth/errors';
import { Checkbox, RecoveryKeyCard } from '@/features/auth/RecoveryKeyCard';
import { generateRecoveryKey } from '@/features/auth/validation';
import { haptics } from '@/lib/haptics';

/** Replace the recovery key. The old key stops working once the new one is saved. */
export default function RecoveryKeySettingsScreen() {
  const toast = useToast();
  const [key, setKey] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (!key) return;
    setBusy(true);
    try {
      await authClient.rotateRecoveryKey(key);
      haptics.success();
      toast.show({
        title: 'New recovery key saved',
        message: 'Your old key no longer works.',
        tone: 'success',
      });
      router.back();
    } catch (e) {
      toast.show({
        title: 'Couldn’t save the new key',
        message: authErrorMessage(e),
        tone: 'error',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="flex-grow gap-6 px-6 pb-8 pt-4"
    >
      <Text variant="body" tone="secondary">
        Your recovery key restores your account if you lose all your devices. Koode only keeps a
        fingerprint of it, so it can’t be shown again. If you’ve lost it, or think someone else has
        seen it, create a new one.
      </Text>
      {key ? (
        <>
          <RecoveryKeyCard recoveryKey={key} />
          <View className="flex-1" />
          <Checkbox
            checked={saved}
            onChange={setSaved}
            label="I’ve saved the new key somewhere safe"
          />
          <Button
            label="Use New Key"
            disabled={!saved}
            loading={busy}
            fullWidth
            onPress={confirm}
          />
        </>
      ) : (
        <Button
          label="Create New Recovery Key"
          icon="key"
          fullWidth
          onPress={() => setKey(generateRecoveryKey(Crypto.getRandomBytes))}
        />
      )}
    </ScrollView>
  );
}
