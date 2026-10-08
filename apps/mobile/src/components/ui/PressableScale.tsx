import type { ReactNode } from 'react';
import type { PressableProps, StyleProp, ViewStyle } from 'react-native';
import { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { springs } from '@/theme/tokens';
import { MotionPressable } from './MotionView';

export type PressableScaleProps = Omit<PressableProps, 'children' | 'style'> & {
  children: ReactNode;
  className?: string;
  style?: StyleProp<ViewStyle>;
  /** Scale at full press. Keep close to 1 — motion should be felt, not seen. */
  activeScale?: number;
};

/** A Pressable that springs down slightly while held. Base for buttons and cards. */
export function PressableScale({
  children,
  className,
  style,
  activeScale = 0.97,
  onPressIn,
  onPressOut,
  disabled,
  ...props
}: PressableScaleProps) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <MotionPressable
      {...props}
      disabled={disabled}
      className={className}
      style={[style, disabled && { opacity: 0.45 }]}
      animatedStyle={animatedStyle}
      onPressIn={(e) => {
        scale.set(withSpring(activeScale, springs.snappy));
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        scale.set(withSpring(1, springs.snappy));
        onPressOut?.(e);
      }}
    >
      {children}
    </MotionPressable>
  );
}
