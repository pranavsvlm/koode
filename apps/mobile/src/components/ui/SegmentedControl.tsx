import { useState } from 'react';
import { Pressable, View, type LayoutChangeEvent } from 'react-native';
import { useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { haptics } from '@/lib/haptics';
import { cn } from '@/lib/cn';
import { springs } from '@/theme/tokens';
import { Text } from './Text';
import { MotionView } from './MotionView';

export type SegmentedControlProps<T extends string> = {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  accessibilityLabel?: string;
};

/** Segmented control with a spring-animated selection thumb. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
  accessibilityLabel,
}: SegmentedControlProps<T>) {
  const [width, setWidth] = useState(0);
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const segment = width > 0 ? (width - 8) / options.length : 0;

  const thumbStyle = useAnimatedStyle(() => ({
    width: segment,
    transform: [{ translateX: withSpring(index * segment, springs.snappy) }],
  }));

  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      className={cn('h-9 flex-row rounded-md bg-fill p-1', className)}
    >
      {segment > 0 && (
        <MotionView
          className="absolute bottom-1 left-1 top-1 rounded-sm bg-surface-raised"
          animatedStyle={thumbStyle}
          style={[
            {
              shadowColor: '#000',
              shadowOpacity: 0.08,
              shadowRadius: 4,
              shadowOffset: { width: 0, height: 1 },
              elevation: 1,
            },
          ]}
        />
      )}
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => {
              if (!selected) haptics.selection();
              onChange(option.value);
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            className="flex-1 items-center justify-center"
          >
            <Text
              variant="footnote"
              tone={selected ? 'primary' : 'secondary'}
              className="font-semibold"
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
