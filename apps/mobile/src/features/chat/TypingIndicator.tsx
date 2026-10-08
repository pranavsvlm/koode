import { useEffect } from 'react';
import { View } from 'react-native';
import {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { Text } from '@/components/ui';
import { MotionView } from '@/components/ui/MotionView';

function Dot({ delay }: { delay: number }) {
  const reduceMotion = useReducedMotion();
  const y = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) return;
    y.value = withDelay(
      delay,
      withRepeat(
        withSequence(withTiming(-3, { duration: 280 }), withTiming(0, { duration: 280 })),
        -1,
      ),
    );
  }, [delay, reduceMotion, y]);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: y.value }],
    opacity: 0.55 + (-y.value / 3) * 0.45,
  }));
  return <MotionView className="h-2 w-2 rounded-full bg-text-secondary" animatedStyle={style} />;
}

export function TypingIndicator({ name }: { name?: string }) {
  return (
    <MotionView
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(150)}
      className="flex-row items-end gap-2 px-4 pb-1 pt-2"
      accessibilityLiveRegion="polite"
      accessibilityLabel={name ? `${name} is typing` : 'Typing'}
    >
      <View className="h-9 flex-row items-center gap-1 rounded-bubble bg-bubble-incoming px-4">
        <Dot delay={0} />
        <Dot delay={140} />
        <Dot delay={280} />
      </View>
      {name && (
        <Text variant="caption" tone="tertiary" className="mb-1">
          {name}
        </Text>
      )}
    </MotionView>
  );
}
