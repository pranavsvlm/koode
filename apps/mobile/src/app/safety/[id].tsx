import { Stack, useLocalSearchParams } from 'expo-router';
import { ScrollView, View } from 'react-native';
import { Button, Icon, Text, useToast } from '@/components/ui';
import { safetyRows, useSafety } from '@/features/crypto/useSafety';
import { detailOptions } from '@/navigation/options';
import { useChat } from '@/stores/chat';
import { useThemeColors } from '@/theme/ThemeProvider';

/**
 * Safety numbers between this device and each of someone's devices. If both
 * people see the same numbers (compared in person or on a call), nobody is
 * in the middle of their encrypted conversation.
 */
export default function SafetyNumberScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useThemeColors();
  const toast = useToast();
  const name = useChat((s) => s.contacts[id]?.displayName) ?? 'They';
  const first = name.split(' ')[0];
  const safety = useSafety(id);

  return (
    <ScrollView className="bg-background" contentContainerClassName="gap-6 px-4 pb-16 pt-4">
      <Stack.Screen options={{ ...detailOptions(colors), title: 'Safety Number' }} />

      <View className="items-center gap-2 px-2">
        <View className="h-14 w-14 items-center justify-center rounded-full bg-fill">
          <Icon
            name="shield"
            size={26}
            color={safety.verification === 'changed' ? 'warning' : 'accent'}
          />
        </View>
        <Text variant="title3" className="text-center">
          {safety.verification === 'verified'
            ? `${first} is verified`
            : safety.verification === 'changed'
              ? `${first}’s safety number changed`
              : `Verify ${first}`}
        </Text>
        <Text variant="subhead" tone="secondary" className="text-center">
          {safety.verification === 'changed'
            ? `${first} has a new device or reinstalled Koode since you verified. Compare the numbers again.`
            : `Compare these numbers with ${first} in person or on a call. If they match, your messages and calls are end-to-end encrypted with ${first}’s real devices.`}
        </Text>
      </View>

      {safety.status === 'loading' && (
        <Text variant="subhead" tone="secondary" className="text-center">
          Loading…
        </Text>
      )}
      {safety.status === 'unavailable' && (
        <Text variant="subhead" tone="secondary" className="text-center">
          Safety numbers aren’t available right now. Check your connection and try again.
        </Text>
      )}
      {safety.status === 'ready' && safety.devices.length === 0 && (
        <Text variant="subhead" tone="secondary" className="text-center">
          {first} hasn’t set up encryption yet: they need to update Koode.
        </Text>
      )}

      {safety.devices.map((d) => (
        <View key={d.deviceId} className="gap-2">
          <Text variant="footnote" tone="secondary" className="ml-4 font-medium uppercase">
            {safety.devices.length > 1 ? `Device ${d.deviceId}` : 'Safety number'}
          </Text>
          <View
            className="items-center gap-1.5 rounded-xl bg-surface px-4 py-4"
            accessible
            accessibilityLabel={`Safety number ${d.safetyNumber.split('').join(' ')}`}
          >
            {safetyRows(d.safetyNumber).map((row) => (
              <Text key={row} variant="title3" className="font-mono tracking-wider">
                {row}
              </Text>
            ))}
          </View>
        </View>
      ))}

      {safety.status === 'ready' && safety.devices.length > 0 && (
        <Button
          label={safety.verification === 'verified' ? 'Clear Verification' : 'Mark as Verified'}
          variant={safety.verification === 'verified' ? 'secondary' : 'primary'}
          fullWidth
          onPress={async () => {
            const verified = safety.verification !== 'verified';
            await safety.setVerified(verified);
            toast.show({
              title: verified ? `${first} marked as verified` : 'Verification cleared',
              tone: 'success',
            });
          }}
        />
      )}
    </ScrollView>
  );
}
