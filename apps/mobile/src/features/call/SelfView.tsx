import { LinearGradient } from 'expo-linear-gradient';
import { useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon, Text } from '@/components/ui';
import { springs } from '@/theme/tokens';

const W = 108;
const H = 160;
const MARGIN = 16;

/**
 * Picture-in-picture self view. Drag it anywhere; it springs to the nearest
 * corner on release, like FaceTime. Shows a placeholder until the camera
 * pipeline lands in Phase 5.
 */
export function SelfView({ cameraOn, bottomInset }: { cameraOn: boolean; bottomInset: number }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const minX = MARGIN;
  const maxX = width - W - MARGIN;
  const minY = insets.top + 56;
  const maxY = height - H - bottomInset;

  const x = useSharedValue(maxX);
  const y = useSharedValue(minY);
  const start = useSharedValue({ x: 0, y: 0 });

  const pan = Gesture.Pan()
    .onBegin(() => {
      start.value = { x: x.value, y: y.value };
    })
    .onUpdate((e) => {
      x.value = start.value.x + e.translationX;
      y.value = start.value.y + e.translationY;
    })
    .onEnd((e) => {
      // Project the fling a little, then snap to the nearest corner.
      const px = x.value + e.velocityX * 0.15;
      const py = y.value + e.velocityY * 0.15;
      x.value = withSpring(px < width / 2 - W / 2 ? minX : maxX, springs.gentle);
      y.value = withSpring(py < height / 2 - H / 2 ? minY : maxY, springs.gentle);
    });

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }],
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        accessibilityLabel={cameraOn ? 'Your camera preview' : 'Your camera is off'}
        style={[
          style,
          {
            position: 'absolute',
            width: W,
            height: H,
            borderRadius: 18,
            overflow: 'hidden',
            shadowColor: '#000',
            shadowOpacity: 0.35,
            shadowRadius: 12,
            shadowOffset: { width: 0, height: 6 },
            elevation: 8,
          },
        ]}
      >
        <LinearGradient
          colors={cameraOn ? ['#3A4A6B', '#1B2236'] : ['#24272E', '#15171C']}
          style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6 }}
        >
          <Icon
            name={cameraOn ? 'person' : 'video-off'}
            size={cameraOn ? 44 : 26}
            color="rgba(255,255,255,0.7)"
          />
          {!cameraOn && (
            <Text variant="caption" style={{ color: 'rgba(255,255,255,0.7)' }}>
              Camera off
            </Text>
          )}
        </LinearGradient>
      </Animated.View>
    </GestureDetector>
  );
}
