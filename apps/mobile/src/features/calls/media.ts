import { AudioSession } from '@livekit/react-native';
import {
  ConnectionQuality,
  Room,
  RoomEvent,
  Track,
  type LocalVideoTrack,
  type Participant,
  type RemoteVideoTrack,
} from 'livekit-client';
import { Platform } from 'react-native';

export type MediaState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export type MediaQuality = 'good' | 'poor' | 'lost';

export type MediaEvents = {
  state: (state: MediaState) => void;
  /** The other person joined (true) or left (false) the room. */
  remote: (present: boolean) => void;
  quality: (quality: MediaQuality) => void;
  /** Video tracks changed (render with `localVideo()` / `remoteVideo()`). */
  video: () => void;
};

/** Media transport for a call. LiveKit in the app; a fake in tests. */
export interface MediaSession {
  connect(url: string, token: string, opts: { camera: boolean }): Promise<void>;
  disconnect(): Promise<void>;
  setMicrophone(enabled: boolean): Promise<void>;
  /** Resolves false if the camera is unavailable (e.g. the iOS Simulator). */
  setCamera(enabled: boolean): Promise<boolean>;
  flipCamera(front: boolean): Promise<void>;
  setSpeaker(on: boolean): Promise<void>;
  on<E extends keyof MediaEvents>(event: E, listener: MediaEvents[E]): () => void;
  localVideo(): LocalVideoTrack | undefined;
  remoteVideo(): RemoteVideoTrack | undefined;
}

const toQuality = (q: ConnectionQuality): MediaQuality =>
  q === ConnectionQuality.Poor ? 'poor' : q === ConnectionQuality.Lost ? 'lost' : 'good';

/** LiveKit implementation (WebRTC via @livekit/react-native-webrtc). */
export function liveKitSession(): MediaSession {
  const room = new Room({ adaptiveStream: true, dynacast: true });
  const listeners: { [E in keyof MediaEvents]: Set<MediaEvents[E]> } = {
    state: new Set(),
    remote: new Set(),
    quality: new Set(),
    video: new Set(),
  };
  const emit = <E extends keyof MediaEvents>(e: E, ...args: Parameters<MediaEvents[E]>) =>
    listeners[e].forEach((l) => (l as (...a: Parameters<MediaEvents[E]>) => void)(...args));
  const isRemote = (p: Participant) => p.identity !== room.localParticipant.identity;

  room
    .on(RoomEvent.Connected, () => emit('state', 'connected'))
    .on(RoomEvent.Reconnecting, () => emit('state', 'reconnecting'))
    .on(RoomEvent.Reconnected, () => emit('state', 'connected'))
    .on(RoomEvent.Disconnected, () => emit('state', 'disconnected'))
    .on(RoomEvent.ParticipantConnected, () => emit('remote', true))
    .on(RoomEvent.ParticipantDisconnected, () => emit('remote', room.remoteParticipants.size > 0))
    .on(RoomEvent.ConnectionQualityChanged, (q, p) => {
      if (!isRemote(p)) emit('quality', toQuality(q));
    })
    .on(RoomEvent.TrackSubscribed, () => emit('video'))
    .on(RoomEvent.TrackUnsubscribed, () => emit('video'))
    .on(RoomEvent.TrackMuted, () => emit('video'))
    .on(RoomEvent.TrackUnmuted, () => emit('video'))
    .on(RoomEvent.LocalTrackPublished, () => emit('video'))
    .on(RoomEvent.LocalTrackUnpublished, () => emit('video'));

  return {
    async connect(url, token, { camera }) {
      emit('state', 'connecting');
      await AudioSession.startAudioSession();
      await room.connect(url, token);
      if (room.remoteParticipants.size > 0) emit('remote', true);
      await room.localParticipant.setMicrophoneEnabled(true);
      if (camera) await this.setCamera(true);
    },
    async disconnect() {
      await room.disconnect();
      await AudioSession.stopAudioSession();
    },
    async setMicrophone(enabled) {
      await room.localParticipant.setMicrophoneEnabled(enabled);
    },
    async setCamera(enabled) {
      try {
        await room.localParticipant.setCameraEnabled(
          enabled,
          enabled ? { facingMode: 'user' } : undefined,
        );
        emit('video');
        return true;
      } catch {
        return false; // no camera / permission denied
      }
    },
    async flipCamera(front) {
      const track = room.localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack as
        LocalVideoTrack | undefined;
      await track?.restartTrack({ facingMode: front ? 'user' : 'environment' });
      emit('video');
    },
    async setSpeaker(on) {
      const id =
        Platform.OS === 'ios' ? (on ? 'force_speaker' : 'default') : on ? 'speaker' : 'earpiece';
      await AudioSession.selectAudioOutput(id).catch(() => {});
    },
    on(event, listener) {
      listeners[event].add(listener);
      return () => listeners[event].delete(listener);
    },
    localVideo() {
      const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
      return pub && !pub.isMuted ? (pub.videoTrack as LocalVideoTrack | undefined) : undefined;
    },
    remoteVideo() {
      for (const p of room.remoteParticipants.values()) {
        const pub = p.getTrackPublication(Track.Source.Camera);
        if (pub?.isSubscribed && !pub.isMuted && pub.videoTrack)
          return pub.videoTrack as RemoteVideoTrack;
      }
      return undefined;
    },
  };
}
