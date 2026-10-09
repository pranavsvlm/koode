import { RING_TIMEOUT_MS, type Call, type CallJoin } from '@koode/shared';
import { ApiClientError } from '@/lib/api';
import { CallController, type CallApi } from '../controller';
import type { MediaEvents, MediaSession } from '../media';

const ME = 'usr_me';
const PEER = 'usr_peer';

function fakeClock() {
  let now = 0;
  let id = 0;
  const tasks = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: (fn: () => void, ms: number) => {
      tasks.set(++id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h: unknown) => void tasks.delete(h as number),
    advance(ms: number) {
      now += ms;
      for (const [k, t] of [...tasks]) {
        if (t.at > now) continue;
        tasks.delete(k);
        t.fn();
      }
    },
  };
}

class FakeMedia implements MediaSession {
  connected = false;
  url = '';
  mic = true;
  camera = false;
  front = true;
  speaker = false;
  cameraAvailable = true;
  failConnect = false;
  private l: { [E in keyof MediaEvents]: Set<MediaEvents[E]> } = {
    state: new Set(),
    remote: new Set(),
    quality: new Set(),
    video: new Set(),
  };
  async connect(url: string) {
    if (this.failConnect) throw new Error('no route');
    this.url = url;
    this.connected = true;
  }
  async disconnect() {
    this.connected = false;
  }
  async setMicrophone(on: boolean) {
    this.mic = on;
  }
  async setCamera(on: boolean) {
    if (on && !this.cameraAvailable) return false;
    this.camera = on;
    return true;
  }
  async flipCamera(front: boolean) {
    this.front = front;
  }
  async setSpeaker(on: boolean) {
    this.speaker = on;
  }
  on<E extends keyof MediaEvents>(e: E, fn: MediaEvents[E]) {
    this.l[e].add(fn);
    return () => this.l[e].delete(fn);
  }
  emit<E extends keyof MediaEvents>(e: E, ...a: Parameters<MediaEvents[E]>) {
    this.l[e].forEach((fn) => (fn as (...x: Parameters<MediaEvents[E]>) => void)(...a));
  }
  localVideo() {
    return undefined;
  }
  remoteVideo() {
    return undefined;
  }
}

const call = (patch: Partial<Call> = {}): Call => ({
  id: 'cal_1',
  kind: 'voice',
  callerId: ME,
  calleeId: PEER,
  state: 'ringing',
  createdAt: 0,
  answeredAt: null,
  endedAt: null,
  ...patch,
});
const join = (c: Call): CallJoin => ({ call: c, media: { url: 'wss://lk', token: 't' } });
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const clock = fakeClock();
  const medias: FakeMedia[] = [];
  const api = {
    start: jest.fn(async (_u: string, kind: Call['kind']) => join(call({ kind }))),
    accept: jest.fn(async () =>
      join(call({ callerId: PEER, calleeId: ME, state: 'active', answeredAt: 1 })),
    ),
    decline: jest.fn(async () => call({ state: 'declined' })),
    end: jest.fn(async () => call({ state: 'ended' })),
  } satisfies CallApi;
  const ctrl = new CallController({
    me: () => ME,
    api,
    createMedia: () => {
      const m = new FakeMedia();
      medias.push(m);
      return m;
    },
    timers: clock,
    endedLingerMs: 1000,
  });
  return { ctrl, api, clock, medias, media: () => medias.at(-1)!, snap: () => ctrl.getSnapshot() };
}

describe('CallController — outgoing', () => {
  it('rings, connects media early, and goes live when the callee joins', async () => {
    const t = setup();
    await t.ctrl.start(PEER, 'voice');
    expect(t.snap()).toMatchObject({
      phase: 'outgoing',
      peerId: PEER,
      kind: 'voice',
      speakerOn: false,
    });
    expect(t.media().connected).toBe(true);

    t.ctrl.onServerCall(call({ state: 'active', answeredAt: 5 }));
    expect(t.snap().phase).toBe('connecting');
    t.media().emit('remote', true);
    expect(t.snap().phase).toBe('connected');
  });

  it('turns on camera and speaker for video calls', async () => {
    const t = setup();
    await t.ctrl.start(PEER, 'video');
    expect(t.snap()).toMatchObject({ cameraOn: true, speakerOn: true });
    expect(t.media()).toMatchObject({ camera: true, speaker: true });
  });

  it('reports busy and failures without leaving a call open', async () => {
    const t = setup();
    t.api.start.mockRejectedValueOnce(new ApiClientError('conflict', 'busy', 409));
    await t.ctrl.start(PEER, 'voice');
    expect(t.snap()).toMatchObject({ phase: 'ended', endReason: 'busy' });
    t.clock.advance(1000);
    expect(t.snap().phase).toBe('idle');
  });

  it('cancels unanswered calls after the ring timeout', async () => {
    const t = setup();
    await t.ctrl.start(PEER, 'voice');
    t.clock.advance(RING_TIMEOUT_MS);
    await flush();
    expect(t.api.end).toHaveBeenCalledWith('cal_1');
    expect(t.snap().phase).toBe('ended');
    expect(t.media().connected).toBe(false);
  });

  it('ends when the callee declines', async () => {
    const t = setup();
    await t.ctrl.start(PEER, 'voice');
    t.ctrl.onServerCall(call({ state: 'declined' }));
    expect(t.snap()).toMatchObject({ phase: 'ended', endReason: 'declined' });
    expect(t.media().connected).toBe(false);
  });
});

describe('CallController — incoming', () => {
  const incoming = () => call({ callerId: PEER, calleeId: ME, kind: 'video' });

  it('rings on a server event, then accepts and connects', async () => {
    const t = setup();
    t.ctrl.onServerCall(incoming());
    expect(t.snap()).toMatchObject({ phase: 'incoming', peerId: PEER, kind: 'video' });
    await t.ctrl.accept();
    expect(t.api.accept).toHaveBeenCalledWith('cal_1');
    expect(t.snap().phase).toBe('connecting');
    t.media().emit('remote', true);
    expect(t.snap().phase).toBe('connected');
  });

  it('declines', async () => {
    const t = setup();
    t.ctrl.onServerCall(incoming());
    await t.ctrl.decline();
    expect(t.api.decline).toHaveBeenCalledWith('cal_1');
    expect(t.snap()).toMatchObject({ phase: 'ended', endReason: 'declined' });
  });

  it('stops ringing when the caller gives up', () => {
    const t = setup();
    t.ctrl.onServerCall(incoming());
    t.ctrl.onServerCall({ ...incoming(), state: 'cancelled' });
    expect(t.snap()).toMatchObject({ phase: 'ended', endReason: 'cancelled' });
  });

  it('automatically declines a second call while busy', async () => {
    const t = setup();
    await t.ctrl.start(PEER, 'voice');
    t.ctrl.onServerCall(call({ id: 'cal_2', callerId: 'usr_other', calleeId: ME }));
    expect(t.api.decline).toHaveBeenCalledWith('cal_2');
    expect(t.snap().call?.id).toBe('cal_1');
  });

  it('notifies detached subscribers (as useSyncExternalStore calls them)', () => {
    const t = setup();
    const { subscribe, getSnapshot } = t.ctrl;
    const seen: string[] = [];
    const unsubscribe = subscribe(() => seen.push(getSnapshot().phase));
    t.ctrl.onServerCall(incoming());
    unsubscribe();
    expect(seen).toContain('incoming');
  });

  it('ignores events for other people’s calls', () => {
    const t = setup();
    t.ctrl.onServerCall(call({ id: 'x', callerId: 'a', calleeId: 'b' }));
    expect(t.snap().phase).toBe('idle');
  });
});

describe('CallController — during a call', () => {
  async function connected() {
    const t = setup();
    await t.ctrl.start(PEER, 'voice');
    t.ctrl.onServerCall(call({ state: 'active', answeredAt: 5 }));
    t.media().emit('remote', true);
    return t;
  }

  it('toggles mic, speaker and camera (upgrading voice to video)', async () => {
    const t = await connected();
    await t.ctrl.toggleMic();
    expect(t.media().mic).toBe(false);
    await t.ctrl.toggleSpeaker();
    expect(t.media().speaker).toBe(true);
    await t.ctrl.toggleCamera();
    expect(t.snap()).toMatchObject({ kind: 'video', cameraOn: true });
    await t.ctrl.flipCamera();
    expect(t.media().front).toBe(false);
  });

  it('reports when no camera is available', async () => {
    const t = await connected();
    t.media().cameraAvailable = false;
    await t.ctrl.toggleCamera();
    expect(t.snap()).toMatchObject({ cameraOn: false, cameraUnavailable: true });
  });

  it('shows reconnecting and recovers', async () => {
    const t = await connected();
    t.media().emit('state', 'reconnecting');
    expect(t.snap().phase).toBe('reconnecting');
    t.media().emit('state', 'connected');
    expect(t.snap().phase).toBe('connected');
  });

  it('tracks connection quality', async () => {
    const t = await connected();
    t.media().emit('quality', 'poor');
    expect(t.snap().quality).toBe('poor');
  });

  it('ends the call if media drops for good', async () => {
    const t = await connected();
    t.media().emit('state', 'disconnected');
    await flush();
    expect(t.api.end).toHaveBeenCalled();
    expect(t.snap()).toMatchObject({ phase: 'ended', endReason: 'failed' });
  });

  it('hangs up and returns to idle', async () => {
    const t = await connected();
    await t.ctrl.hangUp();
    expect(t.api.end).toHaveBeenCalledWith('cal_1');
    expect(t.snap()).toMatchObject({ phase: 'ended', endReason: 'ended' });
    t.clock.advance(1000);
    expect(t.snap().phase).toBe('idle');
  });

  it('ends if media cannot connect', async () => {
    const t = setup();
    const ctrl = new CallController({
      me: () => ME,
      api: t.api,
      createMedia: () => Object.assign(new FakeMedia(), { failConnect: true }),
      timers: t.clock,
    });
    await ctrl.start(PEER, 'voice');
    await flush();
    expect(ctrl.getSnapshot()).toMatchObject({ phase: 'ended', endReason: 'failed' });
  });
});
