import { View } from 'react-native';
import { cn } from '@/lib/cn';
import { Text } from './Text';

export function Badge({ count, muted = false }: { count: number; muted?: boolean }) {
  if (count <= 0) return null;
  const label = count > 99 ? '99+' : String(count);
  return (
    <View
      accessibilityLabel={`${count} unread`}
      className={cn(
        'h-[22px] min-w-[22px] items-center justify-center rounded-full px-1.5',
        muted ? 'bg-text-tertiary' : 'bg-accent',
      )}
    >
      <Text variant="caption" tone="inverse" className="font-semibold" allowFontScaling={false}>
        {label}
      </Text>
    </View>
  );
}
