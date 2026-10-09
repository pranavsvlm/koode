import * as SecureStore from 'expo-secure-store';

/**
 * Secrets live in the Keychain / Android Keystore via expo-secure-store,
 * readable only while the device is unlocked and never synced or restored to
 * another device. (Not in SQLite / kv-store, which hold preferences only.)
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

const KEYS = {
  deviceId: 'koode.device.id',
  secretKey: 'koode.device.signing-key',
  refreshToken: 'koode.session.refresh-token',
} as const;

export type StoredDevice = { deviceId: string; secretKey: string };

export const keystore = {
  async loadDevice(): Promise<StoredDevice | null> {
    const [deviceId, secretKey] = await Promise.all([
      SecureStore.getItemAsync(KEYS.deviceId, OPTIONS),
      SecureStore.getItemAsync(KEYS.secretKey, OPTIONS),
    ]);
    return deviceId && secretKey ? { deviceId, secretKey } : null;
  },
  async saveDevice(device: StoredDevice): Promise<void> {
    await SecureStore.setItemAsync(KEYS.secretKey, device.secretKey, OPTIONS);
    await SecureStore.setItemAsync(KEYS.deviceId, device.deviceId, OPTIONS);
  },
  loadRefreshToken: () => SecureStore.getItemAsync(KEYS.refreshToken, OPTIONS),
  saveRefreshToken: (token: string) => SecureStore.setItemAsync(KEYS.refreshToken, token, OPTIONS),
  /** Remove everything that could authenticate as this device. */
  async wipe(): Promise<void> {
    await Promise.all(Object.values(KEYS).map((k) => SecureStore.deleteItemAsync(k, OPTIONS)));
  },
};
