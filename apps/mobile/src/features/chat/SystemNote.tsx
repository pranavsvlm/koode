import { View } from 'react-native';
import { Text } from '@/components/ui';

/** Group changes ("Maya added Dan"): a quiet centred line, not a bubble. */
export function SystemNote({ text }: { text: string }) {
  return (
    <View className="items-center px-8 py-2" accessibilityRole="text">
      <View className="rounded-full bg-fill px-3 py-1">
        <Text variant="caption" tone="secondary" className="text-center">
          {text}
        </Text>
      </View>
    </View>
  );
}
