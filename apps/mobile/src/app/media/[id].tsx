import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  FadeIn,
  FadeOut,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { IconButton, Text, useToast } from '@/components/ui';
import { useVideoPlayer, VideoView } from 'expo-video';
import { ME, type Attachment } from '@/domain/types';
import { MediaActionError, saveToPhotos, shareFile } from '@/features/media/actions';
import { previewSource, useMediaFile } from '@/features/media/useMedia';
import { formatDayDivider, formatTime } from '@/lib/format';
import { useChat } from '@/stores/chat';
import { springs } from '@/theme/tokens';
import { MotionView } from '@/components/ui/MotionView';

export default function MediaViewerScreen() {
  const { id, conversationId } = useLocalSearchParams<{ id: string; conversationId: string }>();
  const message = useChat((s) => s.messages[conversationId]?.find((m) => m.id === id));
  const contacts = useChat((s) => s.contacts);
  const toast = useToast();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [chrome, setChrome] = useState(true);

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);

  const close = () => router.back();
  const toggleChrome = () => setChrome((c) => !c);

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.max(0.8, Math.min(savedScale.value * e.scale, 5));
    })
    .onEnd(() => {
      if (scale.value < 1) {
        scale.value = withSpring(1, springs.snappy);
        tx.value = withSpring(0);
        ty.value = withSpring(0);
      }
      savedScale.value = Math.max(1, scale.value);
    });

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      tx.value = savedTx.value + e.translationX;
      ty.value = savedTy.value + e.translationY;
    })
    .onEnd((e) => {
      if (savedScale.value <= 1) {
        // Not zoomed: a vertical fling dismisses, otherwise spring back.
        if (Math.abs(e.translationY) > 120 || Math.abs(e.velocityY) > 900) {
          ty.value = withTiming(Math.sign(e.translationY || 1) * height, { duration: 180 }, () =>
            scheduleOnRN(close),
          );
        } else {
          tx.value = withSpring(0, springs.snappy);
          ty.value = withSpring(0, springs.snappy);
        }
      } else {
        savedTx.value = tx.value;
        savedTy.value = ty.value;
      }
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      const zoomIn = savedScale.value <= 1;
      scale.value = withSpring(zoomIn ? 2.5 : 1, springs.snappy);
      savedScale.value = zoomIn ? 2.5 : 1;
      tx.value = withSpring(0);
      ty.value = withSpring(0);
      savedTx.value = 0;
      savedTy.value = 0;
    });

  const singleTap = Gesture.Tap().onEnd(() => scheduleOnRN(toggleChrome));

  const gesture = Gesture.Simultaneous(pinch, pan, Gesture.Exclusive(doubleTap, singleTap));

  const imageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity:
      savedScale.value > 1 ? 1 : interpolate(Math.abs(ty.value), [0, 300], [1, 0.2], 'clamp'),
  }));

  const a = message?.attachment;
  if (!message || !a || (a.kind !== 'image' && a.kind !== 'video')) return null;
  const sender = message.senderId === ME ? 'You' : (contacts[message.senderId]?.displayName ?? '');
  const fitted = Math.min(width, (height * a.width) / a.height);

  return (
    <View className="flex-1">
      <StatusBar style="light" hidden={!chrome} />
      <Animated.View
        style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }, backdropStyle]}
      />
      <GestureDetector gesture={gesture}>
        <Animated.View
          style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}
        >
          <Animated.View style={imageStyle}>
            {a.kind === 'video' && !a.poster ? (
              <ViewerVideo
                attachment={a}
                width={fitted}
                height={(fitted * a.height) / a.width}
                label={`Video from ${sender}`}
              />
            ) : (
              <ViewerImage
                attachment={a}
                width={fitted}
                height={(fitted * a.height) / a.width}
                label={`${a.kind === 'video' ? 'Video' : 'Photo'} from ${sender}`}
              />
            )}
          </Animated.View>
        </Animated.View>
      </GestureDetector>

      {chrome && (
        <>
          <MotionView
            entering={FadeIn.duration(150)}
            exiting={FadeOut.duration(150)}
            className="absolute left-0 right-0 top-0"
          >
            <View
              className="flex-row items-center gap-2 bg-black/40 px-2 pb-2"
              style={{ paddingTop: insets.top + 4 }}
            >
              <IconButton icon="close" accessibilityLabel="Close" onPress={close} color="#FFFFFF" />
              <View className="flex-1 items-center pr-11">
                <Text variant="headline" style={{ color: '#FFFFFF' }}>
                  {sender}
                </Text>
                <Text variant="caption" style={{ color: 'rgba(255,255,255,0.7)' }}>
                  {formatDayDivider(message.createdAt)} at {formatTime(message.createdAt)}
                </Text>
              </View>
            </View>
          </MotionView>
          <MotionView
            entering={FadeIn.duration(150)}
            exiting={FadeOut.duration(150)}
            className="absolute bottom-0 left-0 right-0"
          >
            <View
              className="flex-row justify-between bg-black/40 px-4 pt-2"
              style={{ paddingBottom: Math.max(insets.bottom, 12) }}
            >
              <IconButton
                icon="share"
                accessibilityLabel="Share"
                color="#FFFFFF"
                onPress={() =>
                  void shareFile(a).catch((e: unknown) =>
                    toast.show({ title: 'Couldn’t share', message: errorText(e), tone: 'error' }),
                  )
                }
              />
              {message.text && (
                <Text
                  variant="subhead"
                  style={{ color: '#FFFFFF' }}
                  className="flex-1 self-center px-3 text-center"
                  numberOfLines={2}
                >
                  {message.text}
                </Text>
              )}
              <IconButton
                icon="download"
                accessibilityLabel="Save to Photos"
                color="#FFFFFF"
                onPress={() =>
                  void saveToPhotos(a)
                    .then(() => toast.show({ title: 'Saved to Photos', tone: 'success' }))
                    .catch((e: unknown) =>
                      toast.show({ title: 'Couldn’t save', message: errorText(e), tone: 'error' }),
                    )
                }
              />
            </View>
          </MotionView>
        </>
      )}
    </View>
  );
}

const errorText = (e: unknown) =>
  e instanceof MediaActionError ? e.message : 'Check your connection and try again.';

type Visual = Extract<Attachment, { kind: 'image' | 'video' }>;

/** Full-size photo (or a sample video's still). */
function ViewerImage(p: { attachment: Visual; width: number; height: number; label: string }) {
  const a = p.attachment;
  const bundled = a.kind === 'image' ? a.source : a.poster;
  const file = useMediaFile(bundled ? undefined : a, a.kind === 'image' ? 'content' : 'thumbnail');
  return (
    <Image
      source={bundled ?? (file.uri ? { uri: file.uri } : undefined)}
      placeholder={previewSource(a)}
      style={{ width: p.width, height: p.height }}
      contentFit="contain"
      transition={150}
      accessibilityLabel={p.label}
    />
  );
}

/** Downloads the video (once; then cached) and plays it with system controls. */
function ViewerVideo(p: { attachment: Visual; width: number; height: number; label: string }) {
  const file = useMediaFile(p.attachment, 'content');
  const poster = useMediaFile(p.attachment, 'thumbnail');
  const player = useVideoPlayer(file.uri ? { uri: file.uri } : null, (pl) => {
    pl.loop = false;
  });
  useEffect(() => {
    if (file.uri) player.play();
  }, [file.uri, player]);

  if (!file.uri) {
    return (
      <View style={{ width: p.width, height: p.height }} className="items-center justify-center">
        <Image
          source={poster.uri ? { uri: poster.uri } : undefined}
          placeholder={previewSource(p.attachment)}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
        />
        {file.failed ? (
          <Text variant="subhead" style={{ color: '#FFFFFF' }}>
            Couldn’t load the video
          </Text>
        ) : (
          <ActivityIndicator color="#FFFFFF" accessibilityLabel="Loading video" />
        )}
      </View>
    );
  }
  return (
    <VideoView
      player={player}
      style={{ width: p.width, height: p.height }}
      nativeControls
      contentFit="contain"
      accessibilityLabel={p.label}
    />
  );
}
