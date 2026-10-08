import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { Icon } from '@/components/ui';
import { haptics } from '@/lib/haptics';
import { springs } from '@/theme/tokens';
import { MotionView } from '@/components/ui/MotionView';

const THRESHOLD = 64;

/** Drag a message to the right to reply (iMessage / Telegram style). */
export function SwipeToReply({ children, onReply }: { children: ReactNode; onReply: () => void }) {
  const x = useSharedValue(0);
  const armed = useSharedValue(false);

  const pan = Gesture.Pan()
    .activeOffsetX(12)
    .failOffsetX(-12)
    .failOffsetY([-10, 10])
    .onUpdate((e) => {
      const next = Math.max(0, Math.min(e.translationX * 0.6, THRESHOLD + 16));
      x.value = next;
      if (!armed.value && next >= THRESHOLD) {
        armed.value = true;
        scheduleOnRN(haptics.tap);
      } else if (armed.value && next < THRESHOLD) {
        armed.value = false;
      }
    })
    .onEnd(() => {
      if (armed.value) scheduleOnRN(onReply);
      armed.value = false;
      x.value = withSpring(0, springs.snappy);
    });

  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const iconStyle = useAnimatedStyle(() => ({
    opacity: interpolate(x.value, [16, THRESHOLD], [0, 1], 'clamp'),
    transform: [{ scale: interpolate(x.value, [16, THRESHOLD], [0.6, 1], 'clamp') }],
  }));

  return (
    <GestureDetector gesture={pan}>
      <View>
        <MotionView
          className="absolute bottom-0 left-3 top-0 justify-center"
          animatedStyle={iconStyle}
          pointerEvents="none"
        >
          <View className="h-8 w-8 items-center justify-center rounded-full bg-fill">
            <Icon name="reply" size={15} color="text-secondary" />
          </View>
        </MotionView>
        <Animated.View style={rowStyle}>{children}</Animated.View>
      </View>
    </GestureDetector>
  );
}
