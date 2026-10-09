import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Icon, Text } from '@/components/ui';
import type { Attachment } from '@/domain/types';
import { useMediaFile } from '@/features/media/useMedia';
import { formatDuration } from '@/lib/format';
import { haptics } from '@/lib/haptics';

type Voice = Extract<Attachment, { kind: 'voice' }>;

/** Voice message: the file plays with expo-audio; sample data simulates playback. */
export function VoiceMessage({ attachment, outgoing }: { attachment: Voice; outgoing: boolean }) {
  const real = !!(attachment.attachmentId || attachment.localUri);
  return real ? (
    <RealVoice attachment={attachment} outgoing={outgoing} />
  ) : (
    <SampleVoice attachment={attachment} outgoing={outgoing} />
  );
}

function RealVoice({ attachment, outgoing }: { attachment: Voice; outgoing: boolean }) {
  const file = useMediaFile(attachment);
  const player = useAudioPlayer(file.uri ? { uri: file.uri } : null, { updateInterval: 100 });
  const status = useAudioPlayerStatus(player);

  // Back to the start when it finishes, ready to play again.
  useEffect(() => {
    if (status.didJustFinish) {
      player.pause();
      void player.seekTo(0);
    }
  }, [status.didJustFinish, player]);

  const toggle = async () => {
    haptics.tap();
    if (status.playing) return player.pause();
    if (!file.uri && !(await file.load())) return;
    await setAudioModeAsync({ playsInSilentMode: true });
    player.play();
  };

  const duration = status.duration > 0 ? status.duration : attachment.durationSec;
  return (
    <Layout
      outgoing={outgoing}
      waveform={attachment.waveform}
      durationSec={attachment.durationSec}
      playing={status.playing}
      loading={file.loading || (status.playing && status.isBuffering)}
      progress={duration > 0 ? status.currentTime / duration : 0}
      label={formatDuration(
        status.playing || status.currentTime > 0 ? status.currentTime : attachment.durationSec,
      )}
      onToggle={() => void toggle()}
    />
  );
}

function SampleVoice({ attachment, outgoing }: { attachment: Voice; outgoing: boolean }) {
  const { durationSec } = attachment;
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

  return (
    <Layout
      outgoing={outgoing}
      waveform={attachment.waveform}
      durationSec={durationSec}
      playing={playing}
      loading={false}
      progress={elapsed / durationSec}
      label={formatDuration(playing ? elapsed : durationSec)}
      onToggle={() => {
        haptics.tap();
        setPlaying((p) => !p);
      }}
    />
  );
}

function Layout(p: {
  outgoing: boolean;
  waveform: number[];
  durationSec: number;
  playing: boolean;
  loading: boolean;
  progress: number;
  label: string;
  onToggle: () => void;
}) {
  const fg = p.outgoing ? 'bg-bubble-outgoing-text' : 'bg-accent';
  const track = p.outgoing ? 'bg-bubble-outgoing-text/40' : 'bg-text-tertiary/50';
  const bars = p.waveform.length > 0 ? p.waveform : Array.from({ length: 32 }, () => 0.3);

  return (
    <View className="w-[220px] flex-row items-center gap-3 py-1">
      <Pressable
        onPress={p.onToggle}
        accessibilityRole="button"
        accessibilityLabel={p.playing ? 'Pause voice message' : 'Play voice message'}
        className={`h-9 w-9 items-center justify-center rounded-full ${p.outgoing ? 'bg-bubble-outgoing-text' : 'bg-accent'}`}
      >
        {p.loading ? (
          <ActivityIndicator size="small" color={p.outgoing ? '#0A84FF' : '#FFFFFF'} />
        ) : (
          <Icon
            name={p.playing ? 'pause' : 'play'}
            size={15}
            color={p.outgoing ? 'bubble-outgoing' : 'accent-foreground'}
          />
        )}
      </Pressable>
      <View className="flex-1 gap-1">
        <View
          className="h-6 flex-row items-center gap-[2px]"
          accessible
          accessibilityLabel={`Voice message, ${Math.round(p.durationSec)} seconds`}
        >
          {bars.map((amp, i) => (
            <View
              key={i}
              className={`flex-1 rounded-full ${i / bars.length <= p.progress && p.progress > 0 ? fg : track}`}
              style={{ height: Math.max(3, amp * 24) }}
            />
          ))}
        </View>
        <Text
          variant="caption"
          tone={p.outgoing ? 'inverse' : 'secondary'}
          style={p.outgoing ? { opacity: 0.8 } : undefined}
        >
          {p.label}
        </Text>
      </View>
    </View>
  );
}
