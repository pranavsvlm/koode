import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Avatar, Text } from '@/components/ui';
import { devImages } from '@/dev/images';
import { CallBackdrop } from '@/features/call/CallBackdrop';
import { CallControls, type CallControl } from '@/features/call/CallControls';
import { CallStatus } from '@/features/call/CallStatus';
import { PulseRings } from '@/features/call/PulseRings';
import { SelfView } from '@/features/call/SelfView';
import { useSimulatedCall } from '@/features/call/useSimulatedCall';
import type { CallKind } from '@/domain/types';
import { useChat } from '@/stores/chat';
import { callColors } from '@/theme/tokens';
import { MotionView } from '@/components/ui/MotionView';

const CONTROLS_HEIGHT = 150;

export default function CallScreen() {
  const params = useLocalSearchParams<{ id: string; kind?: CallKind; accepted?: string }>();
  const contact = useChat((s) => s.contacts[params.id]);
  const addCall = useChat((s) => s.addCall);
  const accepted = params.accepted === '1';
  const [kind, setKind] = useState<CallKind>(params.kind === 'video' ? 'video' : 'voice');
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(params.kind === 'video');
  const [cameraOn, setCameraOn] = useState(true);
  const [frontCamera, setFrontCamera] = useState(true);
  const [chromeVisible, setChromeVisible] = useState(true);
  const { phase, seconds, simulateReconnect, end } = useSimulatedCall({ accepted });
  const [startedAt] = useState(() => Date.now());

  const video = kind === 'video';
  const live = phase === 'connected' || phase === 'reconnecting';

  // Auto-hide controls during a connected video call; tap to bring them back.
  useEffect(() => {
    if (!video || !live || !chromeVisible) return;
    const t = setTimeout(() => setChromeVisible(false), 4500);
    return () => clearTimeout(t);
  }, [video, live, chromeVisible]);

  const hangUp = () => {
    addCall({
      contactId: params.id,
      kind,
      direction: accepted ? 'incoming' : 'outgoing',
      outcome: live ? 'answered' : 'cancelled',
      startedAt,
      durationSec: live ? seconds : 0,
    });
    end();
    setTimeout(() => router.back(), 650);
  };

  if (!contact) return null;

  const controls: CallControl[] = video
    ? [
        {
          key: 'flip',
          icon: 'camera-flip',
          label: frontCamera ? 'Flip' : 'Front',
          onPress: () => setFrontCamera((f) => !f),
        },
        {
          key: 'camera',
          icon: cameraOn ? 'video' : 'video-off',
          label: 'Camera',
          active: !cameraOn,
          onPress: () => setCameraOn((c) => !c),
        },
        {
          key: 'mute',
          icon: muted ? 'mic-off' : 'mic',
          label: 'Mute',
          active: muted,
          onPress: () => setMuted((m) => !m),
        },
      ]
    : [
        {
          key: 'speaker',
          icon: 'speaker',
          label: 'Speaker',
          active: speaker,
          onPress: () => setSpeaker((s) => !s),
        },
        {
          key: 'mute',
          icon: muted ? 'mic-off' : 'mic',
          label: 'Mute',
          active: muted,
          onPress: () => setMuted((m) => !m),
        },
        {
          key: 'video',
          icon: 'video',
          label: 'Video',
          onPress: () => {
            setKind('video');
            setSpeaker(true);
          },
        },
      ];

  return (
    <View className="flex-1" style={{ backgroundColor: callColors.background }}>
      <StatusBar style="light" />
      {video && live ? (
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => setChromeVisible((v) => !v)}
          accessibilityLabel={`${contact.displayName}'s video. Tap to ${chromeVisible ? 'hide' : 'show'} controls`}
        >
          <Animated.View entering={FadeIn.duration(500)} style={StyleSheet.absoluteFill}>
            <Image
              source={devImages.forest.source}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
            />
          </Animated.View>
        </Pressable>
      ) : (
        <CallBackdrop id={contact.id} />
      )}

      <SafeAreaView className="flex-1" edges={['top', 'bottom']} pointerEvents="box-none">
        {(!video || !live || chromeVisible) && (
          <MotionView
            entering={FadeIn.duration(200)}
            exiting={FadeOut.duration(200)}
            className={
              video && live ? 'items-center pt-3' : 'flex-1 items-center justify-center gap-4'
            }
            pointerEvents="box-none"
          >
            {!(video && live) && (
              <PulseRings size={136} active={phase === 'calling' || phase === 'ringing'}>
                <Avatar id={contact.id} name={contact.displayName} size={136} />
              </PulseRings>
            )}
            <View
              className={
                video && live
                  ? 'items-center rounded-full bg-black/35 px-4 py-1.5'
                  : 'mt-4 items-center gap-1'
              }
            >
              <Text
                variant={video && live ? 'headline' : 'title1'}
                style={{ color: callColors.text }}
              >
                {contact.displayName}
              </Text>
              <Pressable
                onLongPress={__DEV__ ? simulateReconnect : undefined}
                accessibilityHint={__DEV__ ? 'Long press to simulate a reconnect' : undefined}
              >
                <CallStatus phase={phase} seconds={seconds} />
              </Pressable>
            </View>
          </MotionView>
        )}
        {video && live && <View className="flex-1" pointerEvents="none" />}

        {(!video || !live || chromeVisible) && (
          <MotionView
            entering={FadeIn.duration(200)}
            exiting={FadeOut.duration(200)}
            className="pb-2"
          >
            <CallControls controls={controls} onEnd={hangUp} />
          </MotionView>
        )}
      </SafeAreaView>

      {video && <SelfView cameraOn={cameraOn} bottomInset={CONTROLS_HEIGHT + 24} />}
    </View>
  );
}
