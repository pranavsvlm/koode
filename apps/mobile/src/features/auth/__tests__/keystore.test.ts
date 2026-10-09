/* eslint-disable @typescript-eslint/no-require-imports -- modules load after their mocks */
const mockItems = new Map<string, { value: string; accessible: unknown }>();

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
  getItemAsync: jest.fn(async (k: string) => mockItems.get(k)?.value ?? null),
  // Like the Keychain: an update keeps the item's original accessibility.
  setItemAsync: jest.fn(async (k: string, value: string, o: { keychainAccessible?: unknown }) => {
    const existing = mockItems.get(k);
    mockItems.set(k, { value, accessible: existing ? existing.accessible : o.keychainAccessible });
  }),
  deleteItemAsync: jest.fn(async (k: string) => void mockItems.delete(k)),
}));

beforeEach(() => {
  mockItems.clear();
  jest.resetModules();
});

it('moves secrets saved by older builds to after-first-unlock, once', async () => {
  mockItems.set('koode.device.id', { value: 'dev_1', accessible: 'whenUnlockedThisDeviceOnly' });
  mockItems.set('koode.device.signing-key', {
    value: 'sk',
    accessible: 'whenUnlockedThisDeviceOnly',
  });
  mockItems.set('koode.session.refresh-token', {
    value: 'rt',
    accessible: 'whenUnlockedThisDeviceOnly',
  });
  const { keystore } = require('../keystore') as typeof import('../keystore');

  expect(await keystore.loadDevice()).toEqual({ deviceId: 'dev_1', secretKey: 'sk' });
  for (const k of ['koode.device.id', 'koode.device.signing-key', 'koode.session.refresh-token']) {
    expect(mockItems.get(k)).toEqual({
      value: expect.any(String),
      accessible: 'afterFirstUnlockThisDeviceOnly',
    });
  }
  expect(await keystore.loadRefreshToken()).toBe('rt');

  const SecureStore = require('expo-secure-store');
  SecureStore.setItemAsync.mockClear();
  await keystore.loadDevice();
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
});

it('saves new secrets with the new accessibility even over old items', async () => {
  mockItems.set('koode.session.refresh-token', {
    value: 'old',
    accessible: 'whenUnlockedThisDeviceOnly',
  });
  const { keystore } = require('../keystore') as typeof import('../keystore');
  await keystore.saveRefreshToken('new');
  expect(mockItems.get('koode.session.refresh-token')).toEqual({
    value: 'new',
    accessible: 'afterFirstUnlockThisDeviceOnly',
  });
});
