import {
  AndroidAudioTypePresets,
  AudioSession,
  RNE2EEManager,
  RNKeyProvider,
} from '@livekit/react-native';
import {
  ConnectionQuality,
  Room,
  RoomEvent,
  Track,
  type LocalVideoTrack,
  type Participant,
  type RemoteVideoTrack,
  VideoPresets,
} from 'livekit-client';
import Storage from 'expo-sqlite/kv-store';
import { PermissionsAndroid, Platform } from 'react-native';

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
  /**
   * Get ready while the call rings or dials (before there's a token): DNS and
   * TLS to the media server, and frame encryption, so answering connects faster.
   */
  prepare?(): Promise<void>;
  /**
   * `key`: the call's media key (base64, 32 bytes); frames are encrypted with it.
   * `speaker`: the loudspeaker is the default output (video calls); Bluetooth or
   * wired earphones are always preferred when connected.
   */
  connect(
    url: string,
    token: string,
    opts: { camera: boolean; key: string; speaker: boolean },
  ): Promise<void>;
  disconnect(): Promise<void>;
  setMicrophone(enabled: boolean): Promise<void>;
  /** Resolves false if the camera is unavailable (e.g. the iOS Simulator). */
  setCamera(enabled: boolean): Promise<boolean>;
  flipCamera(front: boolean): Promise<void>;
  /** On: the loudspeaker. Off: earphones (Bluetooth or wired) if connected, else the earpiece. */
  setSpeaker(on: boolean): Promise<void>;
  /** Whether Bluetooth or wired earphones are connected (Android; iOS routes to them itself). */
  hasEarphones?(): Promise<boolean>;
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

/** The media server's address, remembered from the last call (it isn't secret). */
const MEDIA_URL_KEY = 'koode.media-url';
let mediaUrl: string | null | undefined;
const knownMediaUrl = async () =>
  mediaUrl !== undefined
    ? mediaUrl
    : (mediaUrl = await Storage.getItem(MEDIA_URL_KEY).catch(() => null));
const rememberMediaUrl = (url: string) => {
  if (url === mediaUrl) return;
  mediaUrl = url;
  void Storage.setItem(MEDIA_URL_KEY, url).catch(() => {});
};

/** Earphones first, so a call never ignores them; then the call's default. */
const outputOrder = (speaker: boolean) =>
  speaker
    ? (['bluetooth', 'headset', 'speaker', 'earpiece'] as const)
    : (['bluetooth', 'headset', 'earpiece', 'speaker'] as const);

/** Android 12+ needs "Nearby devices" to use Bluetooth earphones for calls. */
async function allowBluetooth() {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 31) return;
  const permission = PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT;
  if (await PermissionsAndroid.check(permission).catch(() => true)) return;
  await PermissionsAndroid.request(permission, {
    title: 'Use your Bluetooth earphones?',
    message: 'Koode needs Nearby devices to play calls through Bluetooth earphones.',
    buttonPositive: 'Continue',
  }).catch(() => undefined);
}

/**
 * LiveKit implementation (WebRTC via @livekit/react-native-webrtc), with
 * end-to-end encrypted media: every audio and video frame is encrypted on the
 * device (AES-GCM, key derived from the call's media key), so the media
 * server forwards ciphertext only.
 */
export function liveKitSession(): MediaSession {
  const keyProvider = new RNKeyProvider({ sharedKey: true });
  const room = new Room({
    // Receive only the quality the view needs (and pause hidden video)…
    adaptiveStream: true,
    // …and stop encoding layers nobody is receiving.
    dynacast: true,
    // 540p: sharp on a phone screen, and light enough to encode and encrypt in
    // real time on older phones (720p lagged).
    videoCaptureDefaults: { resolution: VideoPresets.h540.resolution },
    publishDefaults: {
      // Three layers (540p, 360p, 180p): the media server forwards the one each
      // receiver's network can carry, and switches as it changes.
      simulcast: true,
      videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
      videoEncoding: VideoPresets.h540.encoding,
      // On a weak uplink, lower resolution and frame rate together instead of
      // freezing.
      degradationPreference: 'balanced',
    },
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

  let prepared: Promise<void> | null = null;
  const prepare = () =>
    (prepared ??= (async () => {
      // Encryption is on before anything is published; there's no unencrypted fallback.
      const url = await knownMediaUrl();
      await Promise.all([
        room.setE2EEEnabled(true),
        url ? room.prepareConnection(url).catch(() => {}) : Promise.resolve(),
      ]);
    })());

  return {
    prepare,
    async connect(url, token, { camera, key, speaker }) {
      emit('state', 'connecting');
      rememberMediaUrl(url);
      await Promise.all([keyProvider.setSharedKey(bytes(key)), prepare()]);
      // Let the system route audio (and follow earphones connecting mid-call):
      // nothing is forced until the Speaker button is used.
      await allowBluetooth();
      await AudioSession.configureAudio({
        android: {
          preferredOutputList: [...outputOrder(speaker)],
          audioTypeOptions: AndroidAudioTypePresets.communication,
        },
        ios: { defaultOutput: speaker ? 'speaker' : 'earpiece' },
      }).catch(() => {});
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
      if (Platform.OS === 'ios') {
        // "default" follows iOS routing: earphones if connected, else the default output.
        await AudioSession.configureAudio({
          ios: { defaultOutput: on ? 'speaker' : 'earpiece' },
        }).catch(() => {});
        await AudioSession.selectAudioOutput(on ? 'force_speaker' : 'default').catch(() => {});
        return;
      }
      const available = await AudioSession.getAudioOutputs().catch(() => [] as string[]);
      const id =
        outputOrder(on).find((o) => available.includes(o)) ?? (on ? 'speaker' : 'earpiece');
      await AudioSession.selectAudioOutput(on ? 'speaker' : id).catch(() => {});
    },
    async hasEarphones() {
      if (Platform.OS !== 'android') return false;
      const available = await AudioSession.getAudioOutputs().catch(() => [] as string[]);
      return available.includes('bluetooth') || available.includes('headset');
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
