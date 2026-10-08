import { useEffect, useState, type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { springs } from '@/theme/tokens';
import { Text } from './Text';
import { MotionView } from './MotionView';

export type SheetProps = {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
};

const OFFSCREEN = 800;

/**
 * Bottom sheet that sizes to its content. Drag down or tap the backdrop to
 * dismiss. For full routes (e.g. the attachment picker) prefer a native
 * `formSheet` screen instead.
 */
export function Sheet({ visible, onClose, title, children }: SheetProps) {
  const insets = useSafeAreaInsets();
  const [mounted, setMounted] = useState(visible);
  const translateY = useSharedValue(OFFSCREEN);
  const backdrop = useSharedValue(0);

  if (visible && !mounted) setMounted(true);

  useEffect(() => {
    if (visible) {
      translateY.value = withSpring(0, springs.gentle);
      backdrop.value = withTiming(1, { duration: 220 });
    } else if (mounted) {
      backdrop.value = withTiming(0, { duration: 180 });
      translateY.value = withTiming(OFFSCREEN, { duration: 220 }, (done) => {
        if (done) scheduleOnRN(setMounted, false);
      });
    }
  }, [visible, mounted, translateY, backdrop]);

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      translateY.set(Math.max(0, e.translationY));
    })
    .onEnd((e) => {
      if (e.translationY > 120 || e.velocityY > 800) {
        scheduleOnRN(onClose);
      } else {
        translateY.set(withSpring(0, springs.snappy));
      }
    });

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.value }] }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdrop.value * 0.4 }));

  if (!mounted) return null;

  return (
    <Modal transparent visible statusBarTranslucent animationType="none" onRequestClose={onClose}>
      <GestureHandlerRootView style={StyleSheet.absoluteFill}>
        <MotionView
          className="bg-scrim"
          style={StyleSheet.absoluteFill}
          animatedStyle={backdropStyle}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
          />
        </MotionView>
        <GestureDetector gesture={pan}>
          <MotionView
            accessibilityViewIsModal
            className="absolute bottom-0 left-0 right-0 rounded-t-[28px] bg-surface-raised"
            style={{ paddingBottom: Math.max(insets.bottom, 16) }}
            animatedStyle={sheetStyle}
          >
            <View className="items-center pb-1 pt-2.5">
              <View className="h-[5px] w-9 rounded-full bg-text-tertiary/40" />
            </View>
            {title && (
              <Text variant="headline" className="px-5 pb-2 pt-2 text-center">
                {title}
              </Text>
            )}
            {children}
          </MotionView>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}
