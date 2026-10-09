import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { FadeInDown } from 'react-native-reanimated';
import { Avatar, Button, Icon, Text, TextField } from '@/components/ui';
import { MotionView } from '@/components/ui/MotionView';
import { authClient } from '@/features/auth';
import { authErrorMessage } from '@/features/auth/errors';
import { formatInviteCode } from '@/features/auth/validation';
import { ApiClientError } from '@/lib/api';
import { useDebouncedLookup } from '@/lib/useDebouncedLookup';
import { useThemeColors } from '@/theme/ThemeProvider';

const previewInvite = async (code: string) => {
  const preview = await authClient.previewInvite(code);
  return {
    ...preview,
    days: Math.max(1, Math.ceil((preview.expiresAt - Date.now()) / 86_400_000)),
  };
};

export default function InviteScreen() {
  // Deep links (koode://invite?code=…) prefill the code.
  const params = useLocalSearchParams<{ code?: string }>();
  const colors = useThemeColors();
  const [code, setCode] = useState(formatInviteCode(params.code ?? ''));
  const complete = code.length === 14;
  const preview = useDebouncedLookup(complete ? code.replace(/-/g, '') : null, previewInvite, 150);
  const valid = preview.state === 'done';
  const days = valid ? preview.value.days : 0;

  const proceed = () => {
    if (valid)
      router.push({ pathname: '/create-profile', params: { code: code.replace(/-/g, '') } });
  };

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
        onSubmitEditing={proceed}
        error={
          preview.state === 'error'
            ? preview.error instanceof ApiClientError && preview.error.code === 'not_found'
              ? 'This invite is invalid, used or expired.'
              : authErrorMessage(preview.error)
            : undefined
        }
      />

      {preview.state === 'checking' && (
        <ActivityIndicator className="mt-6" color={colors['text-tertiary']} />
      )}
      {valid && (
        <MotionView
          entering={FadeInDown.springify().damping(18)}
          className="mt-6 flex-row items-center gap-3 rounded-xl bg-surface p-4"
          accessible
          accessibilityLabel={`Invitation${preview.value.inviterName ? ` from ${preview.value.inviterName}` : ''}. Expires in ${days} days.`}
        >
          {preview.value.inviterName ? (
            <Avatar id={preview.value.inviterName} name={preview.value.inviterName} size={48} />
          ) : (
            <View className="h-12 w-12 items-center justify-center rounded-full bg-accent/10">
              <Icon name="sparkles" size={22} color="accent" />
            </View>
          )}
          <View className="flex-1">
            <Text variant="headline">
              {preview.value.inviterName
                ? `${preview.value.inviterName} invited you`
                : 'You’re invited to Koode'}
            </Text>
            <Text variant="footnote" tone="secondary">
              Invite expires in {days} {days === 1 ? 'day' : 'days'}
            </Text>
          </View>
        </MotionView>
      )}

      <View className="flex-1" />
      <Button label="Continue" disabled={!valid} onPress={proceed} fullWidth className="mt-8" />
    </KeyboardAwareScrollView>
  );
}
