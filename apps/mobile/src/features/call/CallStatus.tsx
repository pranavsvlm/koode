import { View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Icon, Text } from '@/components/ui';
import { formatDuration } from '@/lib/format';
import { callColors } from '@/theme/tokens';
import type { CallPhase } from './useSimulatedCall';

const LABEL: Record<CallPhase, string> = {
  calling: 'Calling…',
  ringing: 'Ringing…',
  connecting: 'Connecting…',
  connected: '',
  reconnecting: 'Reconnecting…',
  ended: 'Call ended',
};

/** Status line under the caller's name: phase text, or the running timer. */
export function CallStatus({ phase, seconds }: { phase: CallPhase; seconds: number }) {
  const text = phase === 'connected' ? formatDuration(seconds) : LABEL[phase];
  return (
    <View className="flex-row items-center gap-1.5" accessibilityLiveRegion="polite">
      {phase === 'reconnecting' && <Icon name="signal-weak" size={14} color="#F5B83D" />}
      <Animated.View key={phase === 'connected' ? 'timer' : phase} entering={FadeIn.duration(200)}>
        <Text
          variant="callout"
          style={{
            color: phase === 'reconnecting' ? '#F5B83D' : callColors.textSecondary,
            fontVariant: ['tabular-nums'],
          }}
        >
          {text}
        </Text>
      </Animated.View>
    </View>
  );
}
