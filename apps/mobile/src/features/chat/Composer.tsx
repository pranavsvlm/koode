import { useEffect, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, {
  FadeInDown,
  FadeOutDown,
  interpolate,
  useAnimatedStyle,
  ZoomIn,
  ZoomOut,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassSurface, Icon, IconButton, Text } from '@/components/ui';
import type { Message } from '@/domain/types';
import {
  MAX_RECORDING_MS,
  useVoiceRecorder,
  type Recording,
} from '@/features/media/useVoiceRecorder';
import { devHandles } from '@/dev/handles';
import { formatDuration } from '@/lib/format';
import { haptics } from '@/lib/haptics';
import { messagePreview } from '@/stores/chat';
import { useThemeColors } from '@/theme/ThemeProvider';
import { MotionView } from '@/components/ui/MotionView';

export type ComposerProps = {
  replyTo?: Message;
  replyToName?: string;
  onCancelReply: () => void;
  onSend: (text: string) => void;
  onAttach: () => void;
  /** A finished voice recording to send. */
  onVoice: (recording: Recording) => void;
  /** Recording isn't possible right now (returns a reason to show). */
  canRecord?: () => string | null;
  onError?: (message: string) => void;
  /** Called as the user types (throttled downstream into typing indicators). */
  onTyping?: () => void;
};

export function Composer({
  replyTo,
  replyToName,
  onCancelReply,
  onSend,
  onAttach,
  onVoice,
  canRecord,
  onError,
  onTyping,
}: ComposerProps) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const hasText = text.trim().length > 0;
  const voice = useVoiceRecorder();

  const startRecording = async () => {
    const reason = canRecord?.();
    if (reason) return onError?.(reason);
    haptics.press();
    try {
      if ((await voice.start()) === 'denied')
        onError?.('Allow microphone access in Settings to record voice messages.');
    } catch {
      onError?.('Couldn’t start recording.');
    }
  };
  const sendRecording = async () => {
    haptics.tap();
    const recording = await voice.finish().catch(() => null);
    if (!recording || recording.durationMs < 500) {
      onError?.('That recording was too short.');
      return;
    }
    onVoice(recording);
  };

  // Development: let the screen tour use the same handlers as the buttons.
  useEffect(() => {
    if (!__DEV__) return;
    devHandles.composer = { startRecording, sendRecording };
    return () => {
      devHandles.composer = undefined;
    };
  });

  // Stop at the limit and send what was recorded.
  useEffect(() => {
    if (voice.active && voice.durationMs >= MAX_RECORDING_MS) void sendRecording();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.active, voice.durationMs]);

  // Hug the keyboard when open; respect the home indicator when closed.
  const { progress } = useReanimatedKeyboardAnimation();
  const padStyle = useAnimatedStyle(() => ({
    paddingBottom: interpolate(progress.value, [0, 1], [Math.max(insets.bottom, 8), 8]),
  }));

  const send = () => {
    if (!hasText) return;
    haptics.tap();
    onSend(text);
    setText('');
  };

  return (
    <GlassSurface>
      {replyTo && (
        <MotionView
          entering={FadeInDown.duration(180)}
          exiting={FadeOutDown.duration(120)}
          className="flex-row items-center gap-3 px-4 pt-2.5"
        >
          <View className="h-9 w-[3px] rounded-full bg-accent" />
          <View className="flex-1">
            <Text variant="caption" tone="accent" className="font-semibold">
              Replying to {replyToName}
            </Text>
            <Text variant="footnote" tone="secondary" numberOfLines={1}>
              {messagePreview(replyTo)}
            </Text>
          </View>
          <IconButton
            icon="close"
            accessibilityLabel="Cancel reply"
            onPress={onCancelReply}
            size={28}
            iconSize={12}
            color="text-secondary"
            className="bg-fill"
          />
        </MotionView>
      )}
      {voice.active ? (
        <MotionView
          className="flex-row items-center gap-3 px-2.5 pt-2"
          animatedStyle={padStyle}
          accessibilityLiveRegion="polite"
        >
          <IconButton
            icon="trash"
            accessibilityLabel="Cancel recording"
            onPress={() => {
              haptics.tap();
              void voice.cancel();
            }}
            size={38}
            iconSize={18}
            color="danger"
            className="bg-fill"
          />
          <View className="h-[38px] flex-1 flex-row items-center gap-2 rounded-[19px] bg-fill px-4">
            <View
              className="h-2.5 w-2.5 rounded-full bg-danger"
              style={{ opacity: 0.4 + voice.level * 0.6 }}
            />
            <Text variant="body" className="font-semibold" accessibilityLabel="Recording">
              {formatDuration(voice.durationMs / 1000)}
            </Text>
            <Text variant="footnote" tone="secondary">
              Recording…
            </Text>
          </View>
          <Pressable
            onPress={() => void sendRecording()}
            accessibilityRole="button"
            accessibilityLabel="Send voice message"
            className="h-[34px] w-[34px] items-center justify-center rounded-full bg-accent active:opacity-80"
          >
            <Icon name="send" size={16} color="accent-foreground" weight="bold" />
          </Pressable>
        </MotionView>
      ) : (
        <MotionView className="flex-row items-end gap-2 px-2.5 pt-2" animatedStyle={padStyle}>
          <IconButton
            icon="plus"
            accessibilityLabel="Add attachment"
            onPress={onAttach}
            size={38}
            iconSize={18}
            color="text-secondary"
            className="bg-fill"
          />
          <View className="min-h-[38px] flex-1 justify-center rounded-[19px] bg-fill px-4">
            <TextInput
              value={text}
              onChangeText={(t) => {
                setText(t);
                if (t.trim()) onTyping?.();
              }}
              placeholder="Message"
              placeholderTextColor={colors['text-tertiary']}
              selectionColor={colors.accent}
              cursorColor={colors.accent}
              multiline
              maxLength={4000}
              accessibilityLabel="Message"
              className="max-h-[120px] py-2 text-body text-text"
              style={{ paddingTop: 8, paddingBottom: 8 }}
            />
          </View>
          <View className="h-[38px] w-[38px] items-center justify-center">
            {hasText ? (
              <Animated.View
                key="send"
                entering={ZoomIn.springify().damping(14)}
                exiting={ZoomOut.duration(100)}
              >
                <Pressable
                  onPress={send}
                  accessibilityRole="button"
                  accessibilityLabel="Send message"
                  className="h-[34px] w-[34px] items-center justify-center rounded-full bg-accent active:opacity-80"
                >
                  <Icon name="send" size={16} color="accent-foreground" weight="bold" />
                </Pressable>
              </Animated.View>
            ) : (
              <Animated.View
                key="mic"
                entering={ZoomIn.springify().damping(14)}
                exiting={ZoomOut.duration(100)}
              >
                <IconButton
                  icon="mic"
                  accessibilityLabel="Record voice message"
                  onPress={() => void startRecording()}
                  size={38}
                  iconSize={20}
                  color="text-secondary"
                />
              </Animated.View>
            )}
          </View>
        </MotionView>
      )}
    </GlassSurface>
  );
}
