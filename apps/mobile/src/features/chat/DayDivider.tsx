import { View } from 'react-native';
import { Text } from '@/components/ui';

export function DayDivider({ label }: { label: string }) {
  return (
    <View className="items-center py-3" accessibilityRole="header">
      <View className="rounded-full bg-fill px-3 py-1">
        <Text variant="caption" tone="secondary" className="font-semibold">
          {label}
        </Text>
      </View>
    </View>
  );
}
