import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { FadeInDown } from 'react-native-reanimated';
import { Avatar, Button, Text, TextField } from '@/components/ui';
import { formatInviteCode } from '@/features/auth/validation';
import { MotionView } from '@/components/ui/MotionView';

export default function InviteScreen() {
  // Deep links (koode://invite?code=…) prefill the code.
  const params = useLocalSearchParams<{ code?: string }>();
  const [code, setCode] = useState(formatInviteCode(params.code ?? ''));
  const complete = code.length === 14;

  return (
    <KeyboardAwareScrollView
      className="flex-1 bg-background"
      contentContainerClassName="flex-grow px-6 pb-8 pt-4"
      keyboardShouldPersistTaps="handled"
      bottomOffset={24}
    >
      <View className="gap-2">
        <Text variant="large-title">Enter your invite</Text>
        <Text variant="body" tone="secondary">
          Ask the person who invited you for their 12-character code, or open their invite link.
        </Text>
      </View>

      <TextField
        className="mt-8"
        label="Invite code"
        value={code}
        onChangeText={(t) => setCode(formatInviteCode(t))}
        placeholder="XXXX-XXXX-XXXX"
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        textContentType="oneTimeCode"
        style={{ letterSpacing: 2, fontVariant: ['tabular-nums'] }}
        returnKeyType="next"
        onSubmitEditing={() => complete && router.push('/create-profile')}
      />

      {complete && (
        <MotionView
          entering={FadeInDown.springify().damping(18)}
          className="mt-6 flex-row items-center gap-3 rounded-xl bg-surface p-4"
          accessible
          accessibilityLabel="Invitation from Maya Chen. Expires in 6 days."
        >
          <Avatar id="maya" name="Maya Chen" size={48} />
          <View className="flex-1">
            <Text variant="headline">Maya Chen invited you</Text>
            <Text variant="footnote" tone="secondary">
              Invite expires in 6 days
            </Text>
          </View>
        </MotionView>
      )}

      <View className="flex-1" />
      <Button
        label="Continue"
        disabled={!complete}
        onPress={() => router.push('/create-profile')}
        fullWidth
        className="mt-8"
      />
      <Text variant="footnote" tone="tertiary" className="mt-3 text-center">
        Development build: any complete code is accepted. Invites are verified from Phase 3.
      </Text>
    </KeyboardAwareScrollView>
  );
}
