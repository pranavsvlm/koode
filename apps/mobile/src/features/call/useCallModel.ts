import type { VideoTrack } from 'livekit-client';
import { useEffect, useMemo, useState } from 'react';
import type { CallKind } from '@/domain/types';
import { callController, useCall, type EndReason } from '@/features/calls';
import { useChat } from '@/stores/chat';
import { useSimulatedCall, type CallPhase as UiPhase } from './useSimulatedCall';

export type CallModel = {
  live: boolean;
  phase: UiPhase;
  endedLabel?: string;
  seconds: number;
  kind: CallKind;
  micOn: boolean;
  cameraOn: boolean;
  frontCamera: boolean;
  speakerOn: boolean;
  quality: 'good' | 'poor' | 'lost';
  cameraUnavailable: boolean;
  remoteVideo?: VideoTrack;
  localVideo?: VideoTrack;
  toggleMic: () => void;
  toggleCamera: () => void;
  flipCamera: () => void;
  toggleSpeaker: () => void;
  hangUp: () => void;
  simulateReconnect?: () => void;
};

const END_LABEL: Record<EndReason, string> = {
  ended: 'Call ended',
  declined: 'Declined',
  cancelled: 'Call cancelled',
  missed: 'No answer',
  busy: 'Busy',
  failed: 'Call failed',
};

/** Seconds since `since`, ticking once per second while `since` is set. */
function useElapsed(since: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);
  return since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
}

/** Real call via the call controller (LiveKit). */
function useLiveModel(): CallModel {
  const s = useCall();
  // The timer starts when media is actually connected on this device.
  const seconds = useElapsed(
    s.phase === 'connected' || s.phase === 'reconnecting' ? s.connectedAt : null,
  );

  const media = callController.getMedia();
  const videoVersion = s.videoVersion;
  const tracks = useMemo(
    () => ({ remote: media?.remoteVideo(), local: media?.localVideo() }),
    // Re-read when the controller reports a track change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [media, videoVersion],
  );

  const phase: UiPhase =
    s.phase === 'outgoing'
      ? s.call
        ? 'ringing'
        : 'calling'
      : s.phase === 'connected' || s.phase === 'reconnecting' || s.phase === 'connecting'
        ? s.phase
        : s.phase === 'ended'
          ? 'ended'
          : 'connecting';

  return {
    live: true,
    phase,
    endedLabel: s.endReason ? END_LABEL[s.endReason] : undefined,
    seconds,
    kind: s.kind,
    micOn: s.micOn,
    cameraOn: s.cameraOn,
    frontCamera: s.frontCamera,
    speakerOn: s.speakerOn,
    quality: s.quality,
    cameraUnavailable: s.cameraUnavailable,
    remoteVideo: tracks.remote,
    localVideo: tracks.local,
    toggleMic: () => void callController.toggleMic(),
    toggleCamera: () => void callController.toggleCamera(),
    flipCamera: () => void callController.flipCamera(),
    toggleSpeaker: () => void callController.toggleSpeaker(),
    hangUp: () => void callController.hangUp(),
  };
}

/** Design-review simulation (sample data mode). */
function useSampleModel(peerId: string, initialKind: CallKind, accepted: boolean): CallModel {
  const addCall = useChat((s) => s.addCall);
  const sim = useSimulatedCall({ accepted });
  const [kind, setKind] = useState<CallKind>(initialKind);
  const [micOn, setMicOn] = useState(true);
  const [speakerOn, setSpeakerOn] = useState(initialKind === 'video');
  const [cameraOn, setCameraOn] = useState(initialKind === 'video');
  const [frontCamera, setFrontCamera] = useState(true);
  const [startedAt] = useState(() => Date.now());
  const connected = sim.phase === 'connected' || sim.phase === 'reconnecting';

  return {
    live: false,
    phase: sim.phase,
    seconds: sim.seconds,
    kind,
    micOn,
    cameraOn,
    frontCamera,
    speakerOn,
    quality: sim.phase === 'reconnecting' ? 'lost' : 'good',
    cameraUnavailable: false,
    toggleMic: () => setMicOn((m) => !m),
    toggleCamera: () => {
      if (kind === 'voice') {
        setKind('video');
        setSpeakerOn(true);
      }
      setCameraOn((c) => !c);
    },
    flipCamera: () => setFrontCamera((f) => !f),
    toggleSpeaker: () => setSpeakerOn((s) => !s),
    hangUp: () => {
      addCall({
        contactId: peerId,
        kind,
        direction: accepted ? 'incoming' : 'outgoing',
        outcome: connected ? 'answered' : 'cancelled',
        startedAt,
        durationSec: connected ? sim.seconds : 0,
      });
      sim.end();
    },
    simulateReconnect: sim.simulateReconnect,
  };
}

export function useCallModel(peerId: string, kind: CallKind, accepted: boolean): CallModel {
  const live = useChat((s) => s.mode === 'live');
  // Both hooks always run (rules of hooks); the inactive one is inert.
  const liveModel = useLiveModel();
  const sampleModel = useSampleModel(peerId, kind, accepted);
  return live ? liveModel : sampleModel;
}
