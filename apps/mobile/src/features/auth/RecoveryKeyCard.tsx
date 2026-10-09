import * as Clipboard from 'expo-clipboard';
import { Pressable, View } from 'react-native';
import { Button, Icon, Text, useToast } from '@/components/ui';
import { haptics } from '@/lib/haptics';
import { cn } from '@/lib/cn';

/** Shows a recovery key in two rows of three groups, with a copy button. */
export function RecoveryKeyCard({ recoveryKey }: { recoveryKey: string }) {
  const toast = useToast();
  const groups = recoveryKey.split(' ');
  return (
    <View className="gap-3">
      <View
        className="rounded-xl bg-surface px-5 py-6"
        accessible
        accessibilityLabel={`Recovery key: ${recoveryKey.replace(/ /g, '').split('').join(' ')}`}
      >
        <Text
          variant="title3"
          className="text-center"
          style={{ fontVariant: ['tabular-nums'], letterSpacing: 1.5, lineHeight: 34 }}
          selectable
        >
          {groups.slice(0, 3).join(' ')}
          {'\n'}
          {groups.slice(3).join(' ')}
        </Text>
      </View>
      <Button
        label="Copy key"
        icon="copy"
        variant="secondary"
        size="md"
        className="self-center"
        onPress={async () => {
          await Clipboard.setStringAsync(recoveryKey.replace(/ /g, ''));
          toast.show({
            title: 'Recovery key copied',
            message: 'Paste it into your password manager.',
            tone: 'success',
          });
        }}
      />
    </View>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <Pressable
      onPress={() => {
        haptics.selection();
        onChange(!checked);
      }}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      className="flex-row items-center gap-3"
    >
      <View
        className={cn(
          'h-6 w-6 items-center justify-center rounded-[7px]',
          checked ? 'bg-accent' : 'border-2 border-text-tertiary',
        )}
      >
        {checked && <Icon name="check" size={14} color="accent-foreground" weight="bold" />}
      </View>
      <Text variant="subhead" className="flex-1">
        {label}
      </Text>
    </Pressable>
  );
}
