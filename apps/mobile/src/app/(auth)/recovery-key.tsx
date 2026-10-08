import * as Clipboard from 'expo-clipboard';
import * as Crypto from 'expo-crypto';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Button, Icon, Text, useToast } from '@/components/ui';
import { generateRecoveryKey } from '@/features/auth/validation';
import { haptics } from '@/lib/haptics';
import { cn } from '@/lib/cn';
import { useSession } from '@/stores/session';

export default function RecoveryKeyScreen() {
  const { name, username } = useLocalSearchParams<{ name: string; username: string }>();
  const toast = useToast();
  const completeOnboarding = useSession((s) => s.completeOnboarding);
  // Display-only in this build: the key is not stored or registered until Phase 3.
  const [key] = useState(() => generateRecoveryKey(Crypto.getRandomBytes));
  const [saved, setSaved] = useState(false);

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
      <Text variant="body" tone="secondary" className="mt-2">
        If you lose this phone, this key is the only way to get your account back. Keep it somewhere
        safe, like a password manager. Koode can’t recover it for you.
      </Text>

      <View
        className="mt-8 rounded-xl bg-surface px-5 py-6"
        accessible
        accessibilityLabel={`Recovery key: ${key.split('').join(' ')}`}
      >
        <Text
          variant="title3"
          className="text-center"
          style={{ fontVariant: ['tabular-nums'], letterSpacing: 1.5, lineHeight: 34 }}
          selectable
        >
          {/* Two rows of three groups, so the key never wraps mid-way. */}
          {key.split(' ').slice(0, 3).join(' ')}
          {'\n'}
          {key.split(' ').slice(3).join(' ')}
        </Text>
      </View>
      <Button
        label="Copy key"
        icon="copy"
        variant="secondary"
        size="md"
        className="mt-3 self-center"
        onPress={async () => {
          await Clipboard.setStringAsync(key.replace(/ /g, ''));
          toast.show({
            title: 'Recovery key copied',
            message: 'Paste it into your password manager.',
            tone: 'success',
          });
        }}
      />

      <View className="flex-1" />
      <Pressable
        onPress={() => {
          haptics.selection();
          setSaved((s) => !s);
        }}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: saved }}
        className="mb-4 mt-8 flex-row items-center gap-3"
      >
        <View
          className={cn(
            'h-6 w-6 items-center justify-center rounded-[7px]',
            saved ? 'bg-accent' : 'border-2 border-text-tertiary',
          )}
        >
          {saved && <Icon name="check" size={14} color="accent-foreground" weight="bold" />}
        </View>
        <Text variant="subhead" className="flex-1">
          I’ve saved my recovery key somewhere safe
        </Text>
      </Pressable>
      <Button
        label="Finish"
        disabled={!saved}
        fullWidth
        onPress={() => {
          haptics.success();
          completeOnboarding({ displayName: name ?? 'You', username: username ?? 'me', about: '' });
        }}
      />
    </ScrollView>
  );
}
