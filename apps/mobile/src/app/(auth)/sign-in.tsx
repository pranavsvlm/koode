import { useState } from 'react';
import { View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Button, ListRow, ListSection, Text, TextField, useToast } from '@/components/ui';
import { useSession } from '@/stores/session';

export default function SignInScreen() {
  const toast = useToast();
  const completeOnboarding = useSession((s) => s.completeOnboarding);
  const [key, setKey] = useState('');
  const normalized = key.toUpperCase().replace(/[^0-9A-Z]/g, '');

  return (
    <KeyboardAwareScrollView
      className="flex-1 bg-background"
      contentContainerClassName="flex-grow px-6 pb-8 pt-4"
      keyboardShouldPersistTaps="handled"
      bottomOffset={24}
    >
      <Text variant="large-title">Welcome back</Text>
      <Text variant="body" tone="secondary" className="mt-2">
        Use another device you’re signed in on, or your recovery key.
      </Text>

      <ListSection className="mt-8">
        <ListRow
          icon="qr"
          title="Link from another device"
          subtitle="Scan a code shown on your other phone"
          accessory={{ type: 'chevron' }}
          onPress={() => toast.show({ title: 'Device linking arrives in Phase 3', tone: 'info' })}
        />
      </ListSection>

      <View className="my-6 flex-row items-center gap-3">
        <View className="h-px flex-1 bg-separator" />
        <Text variant="footnote" tone="tertiary">
          or
        </Text>
        <View className="h-px flex-1 bg-separator" />
      </View>

      <TextField
        label="Recovery key"
        value={key}
        onChangeText={setKey}
        placeholder="XXXX XXXX XXXX XXXX XXXX XXXX"
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        secureTextEntry={false}
        hint="24 characters. Spaces don’t matter."
      />

      <View className="flex-1" />
      <Button
        label="Restore account"
        disabled={normalized.length !== 24}
        fullWidth
        className="mt-8"
        onPress={() =>
          completeOnboarding({
            displayName: 'Alex Rivera',
            username: 'alex',
            about: 'Family first.',
          })
        }
      />
      <Text variant="footnote" tone="tertiary" className="mt-3 text-center">
        Development build: any 24-character key restores a sample account.
      </Text>
    </KeyboardAwareScrollView>
  );
}
