import { VideoView } from '@livekit/react-native';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Avatar, Icon, Text } from '@/components/ui';
import { MotionView } from '@/components/ui/MotionView';
import { devImages } from '@/dev/images';
import type { CallKind } from '@/domain/types';
import { CallBackdrop } from '@/features/call/CallBackdrop';
import { CallControls, type CallControl } from '@/features/call/CallControls';
import { CallStatus } from '@/features/call/CallStatus';
import { PulseRings } from '@/features/call/PulseRings';
import { SelfView } from '@/features/call/SelfView';
import { useCallModel } from '@/features/call/useCallModel';
import { useChat } from '@/stores/chat';
import { callColors } from '@/theme/tokens';

const CONTROLS_HEIGHT = 150;
const FILL = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const;

export default function CallScreen() {
  const params = useLocalSearchParams<{ id: string; kind?: CallKind; accepted?: string }>();
  const contact = useChat((s) => s.contacts[params.id]);
  const m = useCallModel(
    params.id,
    params.kind === 'video' ? 'video' : 'voice',
    params.accepted === '1',
  );
  const [chromeVisible, setChromeVisible] = useState(true);

  const video = m.kind === 'video';
  const inCall = m.phase === 'connected' || m.phase === 'reconnecting';
  // Live remote video when it exists; sample mode shows a still.
  const showRemote = video && inCall && (m.live ? !!m.remoteVideo : true);

  // Auto-hide controls during a connected video call; tap to bring them back.
  useEffect(() => {
    if (!showRemote || !chromeVisible) return;
    const t = setTimeout(() => setChromeVisible(false), 4500);
    return () => clearTimeout(t);
  }, [showRemote, chromeVisible]);

  // Show why the call ended for a moment, then close.
  useEffect(() => {
    if (m.phase !== 'ended') return;
    const t = setTimeout(() => {
      if (router.canGoBack()) router.back();
    }, 900);
    return () => clearTimeout(t);
  }, [m.phase]);

  if (!contact) return null;
  const name = contact.displayName;

  const controls: CallControl[] = video
    ? [
        {
          key: 'flip',
          icon: 'camera-flip',
          label: m.frontCamera ? 'Flip' : 'Front',
          onPress: m.flipCamera,
        },
        {
          key: 'camera',
          icon: m.cameraOn ? 'video' : 'video-off',
          label: 'Camera',
          active: !m.cameraOn,
          onPress: m.toggleCamera,
        },
        {
          key: 'mute',
          icon: m.micOn ? 'mic' : 'mic-off',
          label: 'Mute',
          active: !m.micOn,
          onPress: m.toggleMic,
        },
        {
          key: 'speaker',
          icon: 'speaker',
          label: 'Speaker',
          active: m.speakerOn,
          onPress: m.toggleSpeaker,
        },
      ]
    : [
        {
          key: 'speaker',
          icon: 'speaker',
          label: 'Speaker',
          active: m.speakerOn,
          onPress: m.toggleSpeaker,
        },
        {
          key: 'mute',
          icon: m.micOn ? 'mic' : 'mic-off',
          label: 'Mute',
          active: !m.micOn,
          onPress: m.toggleMic,
        },
        { key: 'video', icon: 'video', label: 'Video', onPress: m.toggleCamera },
      ];

  return (
    <View className="flex-1" style={{ backgroundColor: callColors.background }}>
      <StatusBar style="light" />
      {showRemote ? (
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => setChromeVisible((v) => !v)}
          accessibilityLabel={`${name}'s video. Tap to ${chromeVisible ? 'hide' : 'show'} controls`}
        >
          <Animated.View entering={FadeIn.duration(500)} style={StyleSheet.absoluteFill}>
            {m.live && m.remoteVideo ? (
              <VideoView videoTrack={m.remoteVideo} style={FILL} objectFit="cover" zOrder={0} />
            ) : (
              <Image
                source={devImages.forest.source}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
              />
            )}
          </Animated.View>
        </Pressable>
      ) : (
        <CallBackdrop id={contact.id} />
      )}

      <SafeAreaView className="flex-1" edges={['top', 'bottom']} pointerEvents="box-none">
        {(!showRemote || chromeVisible) && (
          <MotionView
            entering={FadeIn.duration(200)}
            exiting={FadeOut.duration(200)}
            className={
              showRemote ? 'items-center pt-3' : 'flex-1 items-center justify-center gap-4'
            }
            pointerEvents="box-none"
          >
            {!showRemote && (
              <PulseRings size={136} active={m.phase === 'calling' || m.phase === 'ringing'}>
                <Avatar id={contact.id} name={name} size={136} />
              </PulseRings>
            )}
            <View
              className={
                showRemote
                  ? 'items-center rounded-full bg-black/35 px-4 py-1.5'
                  : 'mt-4 items-center gap-1'
              }
            >
              <Text variant={showRemote ? 'headline' : 'title1'} style={{ color: callColors.text }}>
                {name}
              </Text>
              <Pressable
                onLongPress={__DEV__ ? m.simulateReconnect : undefined}
                accessibilityHint={
                  __DEV__ && m.simulateReconnect ? 'Long press to simulate a reconnect' : undefined
                }
              >
                <CallStatus
                  phase={m.phase}
                  seconds={m.seconds}
                  endedLabel={m.endedLabel}
                  weak={m.quality === 'poor'}
                />
              </Pressable>
            </View>
            {m.cameraUnavailable && (
              <View className="mt-2 flex-row items-center gap-1.5 rounded-full bg-black/35 px-3 py-1">
                <Icon name="video-off" size={13} color={callColors.textSecondary} />
                <Text variant="caption" style={{ color: callColors.textSecondary }}>
                  Camera unavailable
                </Text>
              </View>
            )}
          </MotionView>
        )}
        {showRemote && <View className="flex-1" pointerEvents="none" />}

        {(!showRemote || chromeVisible) && (
          <MotionView
            entering={FadeIn.duration(200)}
            exiting={FadeOut.duration(200)}
            className="pb-2"
          >
            <CallControls controls={controls} onEnd={m.hangUp} />
          </MotionView>
        )}
      </SafeAreaView>

      {video && (
        <SelfView
          cameraOn={m.cameraOn}
          track={m.localVideo}
          mirror={m.frontCamera}
          unavailable={m.cameraUnavailable}
          bottomInset={CONTROLS_HEIGHT + 24}
        />
      )}
    </View>
  );
}
