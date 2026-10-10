import { VideoView } from '@livekit/react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { TrackEvent, type VideoTrack } from 'livekit-client';
import { useEffect, useReducer } from 'react';
import { useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon, Text } from '@/components/ui';
import { springs } from '@/theme/tokens';
import { KoodeVideoView } from '../../../modules/koode-call-ui';

const W = 108;
const H = 160;
const MARGIN = 16;
const RADIUS = 18;

/**
 * The camera preview. Android draws WebRTC video on a separate surface that
 * ignores rounded clipping, so it uses KoodeVideoView (a TextureView) there.
 */
function Preview({ track, mirror }: { track: VideoTrack; mirror: boolean }) {
  // Flipping the camera can replace the stream; re-render to follow it.
  const [, restarted] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    track.on(TrackEvent.Restarted, restarted);
    return () => void track.off(TrackEvent.Restarted, restarted);
  }, [track]);
  // react-native-webrtc's MediaStream (the DOM type has no toURL).
  const stream = track.mediaStream as unknown as { toURL(): string } | undefined;

  if (KoodeVideoView) {
    return (
      <KoodeVideoView
        streamURL={stream?.toURL() ?? null}
        mirror={mirror}
        cornerRadius={RADIUS}
        style={{ flex: 1 }}
      />
    );
  }
  return (
    <VideoView
      videoTrack={track}
      style={{ flex: 1 }}
      objectFit="cover"
      mirror={mirror}
      zOrder={1}
    />
  );
}

/**
 * Picture-in-picture self view. Drag it anywhere; it springs to the nearest
 * corner on release, like FaceTime. A placeholder shows while the camera is off.
 */
export function SelfView({
  cameraOn,
  bottomInset,
  track,
  mirror = true,
  unavailable = false,
}: {
  cameraOn: boolean;
  bottomInset: number;
  /** Live camera track; without one a placeholder is shown. */
  track?: VideoTrack;
  /** Mirror the front camera, as people expect from a selfie view. */
  mirror?: boolean;
  unavailable?: boolean;
}) {
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
            borderRadius: RADIUS,
            overflow: 'hidden',
            shadowColor: '#000',
            shadowOpacity: 0.35,
            shadowRadius: 12,
            shadowOffset: { width: 0, height: 6 },
            elevation: 8,
          },
        ]}
      >
        {cameraOn && track ? (
          <Preview track={track} mirror={mirror} />
        ) : (
          <LinearGradient
            colors={cameraOn ? ['#3A4A6B', '#1B2236'] : ['#24272E', '#15171C']}
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6 }}
          >
            <Icon
              name={cameraOn ? 'person' : 'video-off'}
              size={cameraOn ? 44 : 26}
              color="rgba(255,255,255,0.7)"
            />
            {(!cameraOn || unavailable) && (
              <Text variant="caption" style={{ color: 'rgba(255,255,255,0.7)' }}>
                {unavailable ? 'No camera' : 'Camera off'}
              </Text>
            )}
          </LinearGradient>
        )}
      </Animated.View>
    </GestureDetector>
  );
}
