import { useEffect } from 'react';
import { View, type DimensionValue } from 'react-native';
import {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { cn } from '@/lib/cn';
import { MotionView } from './MotionView';

export function Skeleton({
  width,
  height,
  radius = 8,
  className,
}: {
  width?: DimensionValue;
  height: number;
  radius?: number;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();
  const opacity = useSharedValue(1);

  useEffect(() => {
    if (reduceMotion) return;
    opacity.value = withRepeat(withTiming(0.45, { duration: 900 }), -1, true);
  }, [opacity, reduceMotion]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <MotionView
      className={cn('bg-fill', className)}
      style={{ width, height, borderRadius: radius }}
      animatedStyle={style}
    />
  );
}

/** Placeholder matching the conversation / contact row layout. */
export function SkeletonRow({ avatarSize = 52 }: { avatarSize?: number }) {
  return (
    <View
      className="flex-row items-center gap-3 px-4 py-2.5"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Skeleton width={avatarSize} height={avatarSize} radius={avatarSize / 2} />
      <View className="flex-1 gap-2">
        <Skeleton width="45%" height={14} />
        <Skeleton width="80%" height={12} />
      </View>
    </View>
  );
}

export function SkeletonList({ rows = 8, avatarSize }: { rows?: number; avatarSize?: number }) {
  return (
    <View accessible accessibilityLabel="Loading" accessibilityRole="progressbar">
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonRow key={i} avatarSize={avatarSize} />
      ))}
    </View>
  );
}
