import { AudioSession, RNE2EEManager, RNKeyProvider } from '@livekit/react-native';
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
  /** Whether the other person's media is arriving end-to-end encrypted. */
  encryption: (encrypted: boolean) => void;
};

/** Media transport for a call. LiveKit in the app; a fake in tests. */
export interface MediaSession {
  /** `key`: the call's media key (base64, 32 bytes); frames are encrypted with it. */
  connect(url: string, token: string, opts: { camera: boolean; key: string }): Promise<void>;
  disconnect(): Promise<void>;
  setMicrophone(enabled: boolean): Promise<void>;
  /** Resolves false if the camera is unavailable (e.g. the iOS Simulator). */
  setCamera(enabled: boolean): Promise<boolean>;
  flipCamera(front: boolean): Promise<void>;
  setSpeaker(on: boolean): Promise<void>;
  on<E extends keyof MediaEvents>(event: E, listener: MediaEvents[E]): () => void;
  localVideo(): LocalVideoTrack | undefined;
  remoteVideo(): RemoteVideoTrack | undefined;
  /**
   * Diagnostics: decoded audio received so far. Frames that fail to decrypt
   * are dropped before decoding, so energy > 0 means decryption works.
   */
  audioStats?(): Promise<{ energy: number; packets: number } | null>;
}

const toQuality = (q: ConnectionQuality): MediaQuality =>
  q === ConnectionQuality.Poor ? 'poor' : q === ConnectionQuality.Lost ? 'lost' : 'good';

const bytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

/**
 * LiveKit implementation (WebRTC via @livekit/react-native-webrtc), with
 * end-to-end encrypted media: every audio and video frame is encrypted on the
 * device (AES-GCM, key derived from the call's media key), so the media
 * server forwards ciphertext only.
 */
export function liveKitSession(): MediaSession {
  const keyProvider = new RNKeyProvider({ sharedKey: true });
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    e2ee: { e2eeManager: new RNE2EEManager(keyProvider) },
  });
  const listeners: { [E in keyof MediaEvents]: Set<MediaEvents[E]> } = {
    state: new Set(),
    remote: new Set(),
    quality: new Set(),
    video: new Set(),
    encryption: new Set(),
  };
  const emit = <E extends keyof MediaEvents>(e: E, ...args: Parameters<MediaEvents[E]>) =>
    listeners[e].forEach((l) => (l as (...a: Parameters<MediaEvents[E]>) => void)(...args));
  const isRemote = (p: Participant) => p.identity !== room.localParticipant.identity;
  /** Encrypting here, and everything the other side publishes is marked encrypted. */
  const checkEncryption = () => {
    const remotes = [...room.remoteParticipants.values()].filter((p) => p.trackPublications.size);
    if (remotes.length)
      emit('encryption', room.isE2EEEnabled && remotes.every((p) => p.isEncrypted));
  };

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
    .on(RoomEvent.LocalTrackUnpublished, () => emit('video'))
    .on(RoomEvent.TrackSubscribed, () => checkEncryption())
    .on(RoomEvent.TrackPublished, () => checkEncryption())
    .on(RoomEvent.EncryptionError, (error) => {
      if (__DEV__) console.warn(`[call] encryption error: ${error.message}`);
      emit('encryption', false);
    });

  return {
    async connect(url, token, { camera, key }) {
      emit('state', 'connecting');
      // Encryption is on before anything is published; there's no unencrypted fallback.
      await keyProvider.setSharedKey(bytes(key));
      await room.setE2EEEnabled(true);
      await AudioSession.startAudioSession();
      await room.connect(url, token);
      if (room.remoteParticipants.size > 0) emit('remote', true);
      await room.localParticipant.setMicrophoneEnabled(true);
      if (camera) await this.setCamera(true);
    },
    async disconnect() {
      await room.disconnect();
      await AudioSession.stopAudioSession();
      keyProvider.dispose();
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
    async audioStats() {
      for (const p of room.remoteParticipants.values()) {
        const track = p.getTrackPublication(Track.Source.Microphone)?.audioTrack;
        const report = await track?.getRTCStatsReport();
        let found: { energy: number; packets: number } | null = null;
        report?.forEach(
          (s: {
            type?: string;
            kind?: string;
            totalAudioEnergy?: number;
            packetsReceived?: number;
          }) => {
            if (s.type === 'inbound-rtp' && s.kind === 'audio')
              found = { energy: s.totalAudioEnergy ?? 0, packets: s.packetsReceived ?? 0 };
          },
        );
        if (found) return found;
      }
      return null;
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
