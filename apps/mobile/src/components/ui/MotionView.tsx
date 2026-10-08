import { cssInterop } from 'nativewind';
import type { ComponentProps, ComponentType } from 'react';
import { Pressable, type PressableProps } from 'react-native';
import Animated from 'react-native-reanimated';

type AnimatedViewProps = ComponentProps<typeof Animated.View>;

export type MotionViewProps = AnimatedViewProps & {
  className?: string;
  /** Output of `useAnimatedStyle`. Kept separate from `style` on purpose (see below). */
  animatedStyle?: AnimatedViewProps['style'];
};

/**
 * An Animated.View that supports `className` *and* a Reanimated animated style.
 *
 * Reanimated's Animated.View must not be registered with NativeWind: NativeWind
 * then re-wraps any Animated.View that receives an animated style and drops its
 * static styles (verified on device). Here NativeWind resolves `className` on
 * this wrapper into plain `style`, and the animated style is merged last.
 */
function MotionViewBase({ style, animatedStyle, ...props }: MotionViewProps) {
  return <Animated.View {...props} style={[style, animatedStyle]} />;
}

export const MotionView = cssInterop(MotionViewBase, { className: 'style' });

// Typed as a plain Pressable whose style may also carry an animated style;
// Reanimated's generated prop types are not usable with a props spread.
const AnimatedPressable = Animated.createAnimatedComponent(Pressable) as unknown as ComponentType<
  Omit<PressableProps, 'style'> & { style?: unknown }
>;

export type MotionPressableProps = PressableProps & {
  className?: string;
  animatedStyle?: AnimatedViewProps['style'];
};

/** Pressable counterpart of MotionView: one element carries layout, look and motion. */
function MotionPressableBase({ style, animatedStyle, ...props }: MotionPressableProps) {
  return <AnimatedPressable {...props} style={[style, animatedStyle]} />;
}

export const MotionPressable = cssInterop(MotionPressableBase, { className: 'style' });
