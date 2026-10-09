import {
  isTerminal,
  RING_TIMEOUT_MS,
  type Call,
  type CallJoin,
  type CallKind,
} from '@koode/shared';
import { ApiClientError } from '@/lib/api';
import type { MediaQuality, MediaSession } from './media';

export type CallPhase =
  'idle' | 'outgoing' | 'incoming' | 'connecting' | 'connected' | 'reconnecting' | 'ended';
export type EndReason = 'ended' | 'declined' | 'cancelled' | 'missed' | 'busy' | 'failed';

export type CallSnapshot = {
  phase: CallPhase;
  call: Call | null;
  peerId: string | null;
  /** Current media kind (a voice call can be upgraded to video). */
  kind: CallKind;
  endReason: EndReason | null;
  micOn: boolean;
  cameraOn: boolean;
  frontCamera: boolean;
  speakerOn: boolean;
  remotePresent: boolean;
  quality: MediaQuality;
  /** Bumped whenever video tracks change, so views re-render. */
  videoVersion: number;
  /** Set when the camera couldn't start (no camera / permission). */
  cameraUnavailable: boolean;
  /** Local time media first connected (drives the call timer). */
  connectedAt: number | null;
};

export type CallApi = {
  start: (userId: string, kind: CallKind) => Promise<CallJoin>;
  accept: (id: string) => Promise<CallJoin>;
  decline: (id: string) => Promise<Call>;
  end: (id: string) => Promise<Call>;
};

export type CallDeps = {
  me: () => string | null;
  api: CallApi;
  createMedia: () => MediaSession;
  timers?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (h: unknown) => void;
  };
  /** How long the "Call ended" state stays before returning to idle. */
  endedLingerMs?: number;
};

const IDLE: CallSnapshot = {
  phase: 'idle',
  call: null,
  peerId: null,
  kind: 'voice',
  endReason: null,
  micOn: true,
  cameraOn: false,
  frontCamera: true,
  speakerOn: false,
  remotePresent: false,
  quality: 'good',
  videoVersion: 0,
  cameraUnavailable: false,
  connectedAt: null,
};

const reasonFor = (state: Call['state']): EndReason =>
  state === 'declined'
    ? 'declined'
    : state === 'cancelled'
      ? 'cancelled'
      : state === 'missed'
        ? 'missed'
        : 'ended';

/**
 * One-to-one call state machine. Signalling goes through the Koode API and
 * realtime events; media through a MediaSession (LiveKit). Framework-agnostic.
 */
export class CallController {
  private deps: Required<CallDeps>;
  private snap: CallSnapshot = IDLE;
  private listeners = new Set<() => void>();
  private media: MediaSession | null = null;
  private unsubs: (() => void)[] = [];
  private ringTimer: unknown = null;
  private lingerTimer: unknown = null;

  constructor(deps: CallDeps) {
    this.deps = {
      timers: {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      },
      endedLingerMs: 1200,
      ...deps,
    };
  }

  // Arrow properties: useSyncExternalStore calls these detached.
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  getSnapshot = () => this.snap;
  /** Exposed for video rendering. */
  getMedia = () => this.media;

  private set(patch: Partial<CallSnapshot>) {
    const next = { ...this.snap, ...patch };
    if (next.phase === 'connected' && next.connectedAt === null) next.connectedAt = Date.now();
    this.snap = next;
    this.listeners.forEach((l) => l());
  }

  private busy() {
    return this.snap.phase !== 'idle' && this.snap.phase !== 'ended';
  }

  // ——— Outgoing ———

  async start(peerId: string, kind: CallKind): Promise<void> {
    if (this.busy()) return;
    this.clearLinger();
    this.set({
      ...IDLE,
      phase: 'outgoing',
      peerId,
      kind,
      cameraOn: kind === 'video',
      speakerOn: kind === 'video',
    });
    let join: CallJoin;
    try {
      join = await this.deps.api.start(peerId, kind);
    } catch (e) {
      this.finish(e instanceof ApiClientError && e.code === 'conflict' ? 'busy' : 'failed');
      return;
    }
    if (this.snap.phase !== 'outgoing') {
      // Hung up while the request was in flight.
      void this.deps.api.end(join.call.id).catch(() => {});
      return;
    }
    this.set({ call: join.call });
    this.ringTimer = this.deps.timers.setTimeout(() => void this.hangUp(), RING_TIMEOUT_MS);
    await this.joinMedia(join);
  }

  // ——— Incoming ———

  /** Realtime `call` event for a call I'm part of. */
  onServerCall(call: Call): void {
    const me = this.deps.me();
    if (!me) return;
    const current = this.snap.call;

    if (call.state === 'ringing' && call.calleeId === me) {
      if (current?.id === call.id) return;
      if (this.busy()) {
        // Already in a call: decline automatically (the caller sees "declined").
        void this.deps.api.decline(call.id).catch(() => {});
        return;
      }
      this.clearLinger();
      this.set({
        ...IDLE,
        phase: 'incoming',
        call,
        peerId: call.callerId,
        kind: call.kind,
        cameraOn: call.kind === 'video',
        speakerOn: call.kind === 'video',
      });
      return;
    }
    if (!current || current.id !== call.id) return;
    this.set({ call });
    if (call.state === 'active' && this.snap.phase === 'outgoing') {
      this.clearRing();
      this.set({ phase: this.snap.remotePresent ? 'connected' : 'connecting' });
    } else if (isTerminal(call.state)) {
      this.finish(reasonFor(call.state));
    }
  }

  async accept(): Promise<void> {
    const call = this.snap.call;
    if (this.snap.phase !== 'incoming' || !call) return;
    this.set({ phase: 'connecting' });
    try {
      const join = await this.deps.api.accept(call.id);
      this.set({ call: join.call });
      await this.joinMedia(join);
    } catch {
      this.finish('failed');
    }
  }

  async decline(): Promise<void> {
    const call = this.snap.call;
    if (this.snap.phase !== 'incoming' || !call) return;
    this.finish('declined');
    await this.deps.api.decline(call.id).catch(() => {});
  }

  // ——— During the call ———

  private async joinMedia(join: CallJoin) {
    const media = this.deps.createMedia();
    this.media = media;
    this.unsubs.push(
      media.on('remote', (present) => {
        this.set({ remotePresent: present });
        if (
          present &&
          (this.snap.phase === 'connecting' ||
            (this.snap.phase === 'outgoing' && this.snap.call?.state === 'active'))
        ) {
          this.set({ phase: 'connected' });
        }
        // The other person dropped out of an established call.
        if (!present && this.snap.phase === 'connected') this.set({ quality: 'lost' });
      }),
      media.on('state', (state) => {
        if (state === 'reconnecting' && this.snap.phase === 'connected')
          this.set({ phase: 'reconnecting' });
        if (state === 'connected' && this.snap.phase === 'reconnecting')
          this.set({ phase: 'connected' });
        if (state === 'disconnected' && this.busy()) void this.hangUp('failed');
      }),
      media.on('quality', (quality) => this.set({ quality })),
      media.on('video', () => this.set({ videoVersion: this.snap.videoVersion + 1 })),
    );
    try {
      await media.connect(join.media.url, join.media.token, { camera: false });
      if (this.snap.cameraOn) await this.setCamera(true);
      if (this.snap.speakerOn) await media.setSpeaker(true);
    } catch {
      void this.hangUp('failed');
    }
  }

  async toggleMic() {
    const micOn = !this.snap.micOn;
    this.set({ micOn });
    await this.media?.setMicrophone(micOn).catch(() => {});
  }

  private async setCamera(on: boolean) {
    const ok = (await this.media?.setCamera(on)) ?? true;
    this.set({ cameraOn: on && ok, cameraUnavailable: on && !ok });
  }

  async toggleCamera() {
    const on = !this.snap.cameraOn;
    if (on && this.snap.kind === 'voice') this.set({ kind: 'video', speakerOn: true });
    this.set({ cameraOn: on });
    await this.setCamera(on);
    if (on) await this.media?.setSpeaker(true);
  }

  async flipCamera() {
    const frontCamera = !this.snap.frontCamera;
    this.set({ frontCamera });
    await this.media?.flipCamera(frontCamera).catch(() => {});
  }

  async toggleSpeaker() {
    const speakerOn = !this.snap.speakerOn;
    this.set({ speakerOn });
    await this.media?.setSpeaker(speakerOn);
  }

  /** Hang up (or cancel an outgoing call). */
  async hangUp(reason: EndReason = 'ended'): Promise<void> {
    const call = this.snap.call;
    if (!this.busy()) return;
    const wasIncoming = this.snap.phase === 'incoming';
    this.finish(wasIncoming ? 'declined' : reason);
    if (call) {
      await (wasIncoming ? this.deps.api.decline(call.id) : this.deps.api.end(call.id)).catch(
        () => {},
      );
    }
  }

  // ——— Teardown ———

  private clearRing() {
    if (this.ringTimer !== null) this.deps.timers.clearTimeout(this.ringTimer);
    this.ringTimer = null;
  }
  private clearLinger() {
    if (this.lingerTimer !== null) this.deps.timers.clearTimeout(this.lingerTimer);
    this.lingerTimer = null;
  }

  private finish(reason: EndReason) {
    this.clearRing();
    this.unsubs.splice(0).forEach((u) => u());
    const media = this.media;
    this.media = null;
    void media?.disconnect().catch(() => {});
    this.set({ phase: 'ended', endReason: reason, remotePresent: false });
    this.clearLinger();
    this.lingerTimer = this.deps.timers.setTimeout(() => {
      this.lingerTimer = null;
      if (this.snap.phase === 'ended') this.set(IDLE);
    }, this.deps.endedLingerMs);
  }
}
