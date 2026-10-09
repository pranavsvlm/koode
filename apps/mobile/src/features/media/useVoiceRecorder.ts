import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
  type RecordingOptions,
} from 'expo-audio';
import { useEffect, useRef, useState } from 'react';
import { levelFromDb } from './process';

/** Voice: mono AAC (.m4a), 64 kbps, with metering for the waveform. */
const VOICE: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  numberOfChannels: 1,
  bitRate: 64_000,
  isMeteringEnabled: true,
};
/** Long recordings stop here (the server accepts up to 30 minutes). */
export const MAX_RECORDING_MS = 15 * 60_000;

export type Recording = { uri: string; durationMs: number; levels: number[] };

/**
 * Tap to record, then send or cancel. Levels (0–1) are sampled while
 * recording to draw the waveform.
 */
export function useVoiceRecorder() {
  const recorder = useAudioRecorder(VOICE);
  const state = useAudioRecorderState(recorder, 100);
  const levels = useRef<number[]>([]);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!state.isRecording) return;
    if (state.metering !== undefined) levels.current.push(levelFromDb(state.metering));
  }, [state.durationMillis, state.isRecording, state.metering]);

  const start = async (): Promise<'started' | 'denied'> => {
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) return 'denied';
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    levels.current = [];
    await recorder.prepareToRecordAsync();
    recorder.record();
    setActive(true);
    return 'started';
  };

  const finish = async (): Promise<Recording | null> => {
    const durationMs = state.durationMillis;
    await recorder.stop();
    setActive(false);
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    const uri = recorder.uri;
    return uri ? { uri, durationMs, levels: levels.current } : null;
  };

  const cancel = async () => {
    if (!active) return;
    await recorder.stop();
    setActive(false);
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
  };

  return {
    active,
    durationMs: state.durationMillis,
    level: state.metering !== undefined ? levelFromDb(state.metering) : 0,
    start,
    finish,
    cancel,
  };
}
