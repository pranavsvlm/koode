import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Avatar, Text, useToast } from '@/components/ui';
import { CallBackdrop } from '@/features/call/CallBackdrop';
import { callController, useCall } from '@/features/calls';
import { openConversation } from '@/features/chat/openConversation';
import { CallControlButton } from '@/features/call/CallControls';
import { PulseRings } from '@/features/call/PulseRings';
import type { CallKind } from '@/domain/types';
import { haptics } from '@/lib/haptics';
import { useChat } from '@/stores/chat';
import { callColors } from '@/theme/tokens';

/**
 * In-app incoming call screen. When the app is in the background, Phase 6
 * routes incoming calls through CallKit (iOS) / the system call UI (Android).
 */
export default function IncomingCallScreen() {
  const { contactId, kind = 'voice' } = useLocalSearchParams<{
    contactId: string;
    kind?: CallKind;
  }>();
  const contact = useChat((s) => s.contacts[contactId]);
  const addCall = useChat((s) => s.addCall);
  const live = useChat((s) => s.mode === 'live');
  const call = useCall();
  const toast = useToast();

  useEffect(() => {
    haptics.press();
    const id = setInterval(haptics.press, 1800);
    return () => clearInterval(id);
  }, []);

  // The caller gave up (or the call was answered on another device): close.
  useEffect(() => {
    if (live && call.phase === 'ended') {
      const t = setTimeout(() => router.canGoBack() && router.back(), 600);
      return () => clearTimeout(t);
    }
  }, [live, call.phase]);

  if (!contact) return null;

  const accept = () => {
    if (live) void callController.accept();
    router.replace({ pathname: '/call/[id]', params: { id: contactId, kind, accepted: '1' } });
  };

  const decline = () => {
    if (live) {
      void callController.decline();
      router.back();
      return;
    }
    addCall({
      contactId,
      kind,
      direction: 'incoming',
      outcome: 'declined',
      startedAt: Date.now(),
      durationSec: 0,
    });
    router.back();
  };

  return (
    <View className="flex-1">
      <StatusBar style="light" />
      <CallBackdrop id={contact.id} />
      <SafeAreaView className="flex-1 justify-between" edges={['top', 'bottom']}>
        <View className="items-center gap-1 pt-16" accessibilityLiveRegion="assertive">
          <Text variant="subhead" style={{ color: callColors.textSecondary }}>
            Koode {kind === 'video' ? 'Video' : 'Audio'}
          </Text>
          <Text variant="large-title" style={{ color: callColors.text }} className="text-center">
            {contact.displayName}
          </Text>
        </View>

        <View className="items-center">
          <PulseRings size={148} active>
            <Avatar id={contact.id} name={contact.displayName} size={148} />
          </PulseRings>
        </View>

        <View className="gap-10 px-10 pb-6">
          <View className="flex-row justify-between px-4">
            <CallControlButton
              icon="clock"
              label="Remind Me"
              size={52}
              onPress={() => {
                decline();
                toast.show({ title: 'Reminders arrive with notifications (Phase 6)' });
              }}
            />
            <CallControlButton
              icon="message"
              label="Message"
              size={52}
              onPress={() => {
                decline();
                openConversation([contactId]).catch(() =>
                  toast.show({ title: 'Couldn’t open the chat', tone: 'error' }),
                );
              }}
            />
          </View>
          <View className="flex-row justify-between">
            <CallControlButton
              icon="end-call"
              label="Decline"
              tone="end"
              size={76}
              onPress={decline}
            />
            <CallControlButton
              icon={kind === 'video' ? 'video' : 'phone'}
              label="Accept"
              tone="accept"
              size={76}
              onPress={accept}
            />
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}
