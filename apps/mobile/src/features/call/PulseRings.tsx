import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

function Ring({ size, delay, active }: { size: number; delay: number; active: boolean }) {
  const reduceMotion = useReducedMotion();
  const t = useSharedValue(0);
  useEffect(() => {
    if (!active || reduceMotion) {
      t.value = withTiming(0, { duration: 300 });
      return;
    }
    t.value = withDelay(
      delay,
      withRepeat(withTiming(1, { duration: 2400, easing: Easing.out(Easing.quad) }), -1, false),
    );
  }, [active, delay, reduceMotion, t]);
  const style = useAnimatedStyle(() => ({
    opacity: active ? (1 - t.value) * 0.35 : 0,
    transform: [{ scale: 1 + t.value * 0.7 }],
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        style,
        {
          position: 'absolute',
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: 1.5,
          borderColor: '#FFFFFF',
        },
      ]}
    />
  );
}

/** Expanding rings behind the caller's avatar while a call is ringing. */
export function PulseRings({
  size,
  active,
  children,
}: {
  size: number;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <View className="items-center justify-center" style={{ width: size, height: size }}>
      <Ring size={size} delay={0} active={active} />
      <Ring size={size} delay={800} active={active} />
      <Ring size={size} delay={1600} active={active} />
      {children}
    </View>
  );
}
