import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useThemeColors } from '@/theme/ThemeProvider';
import { KoodeMark } from './KoodeMark';

/**
 * Picks up exactly where the native splash leaves off (same mark, size and
 * background), then lifts and fades into the app.
 */
export function AnimatedSplash({ onDone }: { onDone: () => void }) {
  const colors = useThemeColors();
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withDelay(
      120,
      withTiming(
        1,
        { duration: reduceMotion ? 200 : 520, easing: Easing.inOut(Easing.cubic) },
        (done) => {
          if (done) scheduleOnRN(onDone);
        },
      ),
    );
  }, [onDone, progress, reduceMotion]);

  const containerStyle = useAnimatedStyle(() => ({ opacity: 1 - progress.value }));
  const markStyle = useAnimatedStyle(() => ({
    transform: [{ scale: reduceMotion ? 1 : 1 + progress.value * 0.35 }],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        styles.center,
        { backgroundColor: colors.background },
        containerStyle,
      ]}
    >
      <Animated.View style={markStyle}>
        <KoodeMark size={120} />
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', zIndex: 100 },
});
