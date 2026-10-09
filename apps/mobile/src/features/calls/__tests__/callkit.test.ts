/* eslint-disable @typescript-eslint/no-require-imports -- modules load after their mocks */
import type { Call, CallJoin } from '@koode/shared';

/** A stand-in for the native KoodeCalls module (PushKit + CallKit). */
type Listener = (e: never) => void;
const mockNative = {
  listeners: new Map<string, Set<Listener>>(),
  endCall: jest.fn(),
  setMuted: jest.fn(),
  reportConnected: jest.fn(),
  startListening: jest.fn(),
  activeCallIds: jest.fn(async () => [] as string[]),
  voipToken: jest.fn(async () => null),
  addListener(event: string, fn: Listener) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(fn);
    this.listeners.set(event, set);
    return { remove: () => set.delete(fn) };
  },
  emit(event: string, body: unknown) {
    this.listeners.get(event)?.forEach((fn) => (fn as (b: unknown) => void)(body));
  },
};
jest.mock('../../../../modules/koode-calls', () => ({ KoodeCalls: mockNative }));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

const ME = 'usr_me';
const mockCall = (patch: Partial<Call> = {}): Call => ({
  id: 'cal_1',
  kind: 'voice',
  callerId: 'usr_peer',
  calleeId: ME,
  state: 'ringing',
  createdAt: 0,
  answeredAt: null,
  endedAt: null,
  ...patch,
});
const join = (c: Call): CallJoin & { mediaKey: string } => ({
  call: c,
  media: { url: 'wss://lk', token: 't' },
  key: null,
  mediaKey: 'bWVkaWEta2V5',
});

const mockApi = {
  start: jest.fn(),
  accept: jest.fn(async (id: string) => join(mockCall({ id, state: 'active', answeredAt: 1 }))),
  decline: jest.fn(async () => mockCall({ state: 'declined' })),
  end: jest.fn(async () => mockCall({ state: 'ended' })),
};
const mockOpen = jest.fn(async () => true);

jest.mock('../index', () => {
  const { CallController } = jest.requireActual('../controller');
  const media = () => ({
    connect: async () => {},
    disconnect: async () => {},
    setMicrophone: async () => {},
    setCamera: async () => true,
    flipCamera: async () => {},
    setSpeaker: async () => {},
    on: () => () => {},
    localVideo: () => undefined,
    remoteVideo: () => undefined,
  });
  return {
    callApi: mockApi,
    callController: new CallController({ me: () => 'usr_me', api: mockApi, createMedia: media }),
  };
});
jest.mock('../incoming', () => ({ openIncomingCall: (...a: unknown[]) => mockOpen(...(a as [])) }));

const { callController } = jest.requireMock('../index');
const { startCallKitBridge, waitForCallKit } = require('../callkit') as typeof import('../callkit');

const flush = () => new Promise((r) => setTimeout(r, 0));
let stop: () => void;
const onVoip = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  stop = startCallKitBridge(onVoip);
});
afterEach(async () => {
  stop();
  await callController.hangUp();
});

it('starts listening only after attaching its listeners', () => {
  expect(mockNative.startListening).toHaveBeenCalledTimes(1);
  expect(mockNative.listeners.get('answer')?.size).toBe(1);
});

it('lets the app skip its own ringing screen when CallKit shows the call', async () => {
  const pending = waitForCallKit('cal_1', 1000);
  mockNative.emit('reported', { callId: 'cal_1' });
  expect(await pending).toBe(true);
  expect(await waitForCallKit('cal_other', 10)).toBe(false);
});

it('answers through the app when the user answers in CallKit', async () => {
  mockNative.emit('answer', { callId: 'cal_1' });
  await flush();
  expect(mockOpen).toHaveBeenCalledWith('cal_1', true);
});

it('ends CallKit’s call if the app can no longer answer it', async () => {
  mockOpen.mockResolvedValueOnce(false);
  mockNative.emit('answer', { callId: 'cal_9' });
  await flush();
  expect(mockNative.endCall).toHaveBeenCalledWith('cal_9', 'failed');
});

it('declines from the system UI, even for a call the app never loaded', async () => {
  callController.onServerCall(mockCall());
  mockNative.emit('reported', { callId: 'cal_1' });
  mockNative.emit('end', { callId: 'cal_1', answered: false });
  await flush();
  expect(mockApi.decline).toHaveBeenCalledWith('cal_1');

  mockNative.emit('end', { callId: 'cal_x', answered: false });
  mockNative.emit('end', { callId: 'cal_y', answered: true });
  await flush();
  expect(mockApi.decline).toHaveBeenCalledWith('cal_x');
  expect(mockApi.end).toHaveBeenCalledWith('cal_y');
});

it('mirrors the app’s call state into CallKit', async () => {
  callController.onServerCall(mockCall({ id: 'cal_2' }));
  mockNative.emit('reported', { callId: 'cal_2' });
  await callController.accept();
  await callController.toggleMic();
  expect(mockNative.setMuted).toHaveBeenCalledWith('cal_2', true);

  // Muting from the system UI drives the app (no echo when already in sync).
  mockNative.emit('mute', { callId: 'cal_2', muted: false });
  expect(callController.getSnapshot().micOn).toBe(true);

  callController.onServerCall(mockCall({ id: 'cal_2', state: 'ended', answeredAt: 1 }));
  expect(mockNative.endCall).toHaveBeenCalledWith('cal_2', 'remoteEnded');
});

it('forwards VoIP token changes so the push registration is updated', () => {
  mockNative.emit('voipToken', { token: 'abc' });
  expect(onVoip).toHaveBeenCalled();
});
