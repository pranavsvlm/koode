import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Icon, Text } from '@/components/ui';
import { formatDuration } from '@/lib/format';
import { haptics } from '@/lib/haptics';

/**
 * Voice note UI with simulated playback progress. Real recording and
 * playback (expo-audio) arrive with media support in Phase 7.
 */
export function VoiceMessage({
  durationSec,
  waveform,
  outgoing,
}: {
  durationSec: number;
  waveform: number[];
  outgoing: boolean;
}) {
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    if (!playing) return;
    timer.current = setInterval(() => {
      setElapsed((e) => {
        if (e + 0.1 >= durationSec) {
          setPlaying(false);
          return 0;
        }
        return e + 0.1;
      });
    }, 100);
    return () => clearInterval(timer.current);
  }, [playing, durationSec]);

  const progress = elapsed / durationSec;
  const fg = outgoing ? 'bg-bubble-outgoing-text' : 'bg-accent';
  const track = outgoing ? 'bg-bubble-outgoing-text/40' : 'bg-text-tertiary/50';

  return (
    <View className="w-[220px] flex-row items-center gap-3 py-1">
      <Pressable
        onPress={() => {
          haptics.tap();
          setPlaying((p) => !p);
        }}
        accessibilityRole="button"
        accessibilityLabel={playing ? 'Pause voice message' : 'Play voice message'}
        className={`h-9 w-9 items-center justify-center rounded-full ${outgoing ? 'bg-bubble-outgoing-text' : 'bg-accent'}`}
      >
        <Icon
          name={playing ? 'pause' : 'play'}
          size={15}
          color={outgoing ? 'bubble-outgoing' : 'accent-foreground'}
        />
      </Pressable>
      <View className="flex-1 gap-1">
        <View
          className="h-6 flex-row items-center gap-[2px]"
          accessible
          accessibilityLabel={`Voice message, ${Math.round(durationSec)} seconds`}
        >
          {waveform.map((amp, i) => (
            <View
              key={i}
              className={`flex-1 rounded-full ${i / waveform.length <= progress && playing ? fg : track}`}
              style={{ height: Math.max(3, amp * 24) }}
            />
          ))}
        </View>
        <Text
          variant="caption"
          tone={outgoing ? 'inverse' : 'secondary'}
          style={outgoing ? { opacity: 0.8 } : undefined}
        >
          {formatDuration(playing ? elapsed : durationSec)}
        </Text>
      </View>
    </View>
  );
}
