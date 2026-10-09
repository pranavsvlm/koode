// In-memory replacement for the native SQLite key-value store.
jest.mock('expo-sqlite/kv-store', () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => data.get(key) ?? null,
    setItem: async (key: string, value: string) => void data.set(key, value),
    removeItem: async (key: string) => void data.delete(key),
  };
  return { __esModule: true, default: storage, Storage: storage };
});

// Reanimated 4 runs on react-native-worklets; use the official mocks in Jest.
// jest.mock factories are hoisted, so they must use require().
/* eslint-disable @typescript-eslint/no-require-imports */
jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'));
jest.mock('react-native-keyboard-controller', () =>
  require('react-native-keyboard-controller/jest'),
);

// LiveKit ships untranspiled native code; calls are exercised through a fake
// MediaSession in tests, so stub the packages for anything that imports them.
jest.mock('@livekit/react-native', () => ({
  registerGlobals: () => {},
  AudioSession: {
    startAudioSession: async () => {},
    stopAudioSession: async () => {},
    selectAudioOutput: async () => {},
  },
  VideoView: () => null,
  RNKeyProvider: class {
    async setSharedKey() {}
    dispose() {}
  },
  RNE2EEManager: class {},
}));
jest.mock('livekit-client', () => {
  class Room {
    on() {
      return this;
    }
    async connect() {}
    async disconnect() {}
  }
  return {
    Room,
    RoomEvent: {},
    ConnectionQuality: {},
    Track: { Source: { Camera: 'camera', Microphone: 'microphone' }, Kind: {} },
  };
});

// The messaging engine reports expected failures (offline sends, undecryptable
// fixtures) in development; keep test output for real warnings.
const warn = console.warn;
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith('[messaging]')) return;
  warn(...args);
};
