import * as SecureStore from 'expo-secure-store';

/**
 * Secrets live in the Keychain / Android Keystore via expo-secure-store,
 * never synced or restored to another device. (Not in SQLite / kv-store,
 * which hold preferences only.)
 *
 * Readable "after first unlock": an incoming call can wake the app while the
 * phone is locked (PushKit/CallKit), and answering it needs the session. Items
 * are still unreadable after a restart until the phone is unlocked once.
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

const KEYS = {
  deviceId: 'koode.device.id',
  secretKey: 'koode.device.signing-key',
  refreshToken: 'koode.session.refresh-token',
} as const;
/** Set once items have been rewritten with the current accessibility class. */
const UPGRADED = 'koode.keystore.after-first-unlock';

export type StoredDevice = { deviceId: string; secretKey: string };

/**
 * The Keychain keeps an item's accessibility on update, so moving items saved
 * by older builds ("when unlocked") needs a delete and re-add.
 */
async function put(key: string, value: string) {
  await SecureStore.deleteItemAsync(key, OPTIONS);
  await SecureStore.setItemAsync(key, value, OPTIONS);
}

let upgrade: Promise<void> | null = null;
function upgradeOnce(): Promise<void> {
  upgrade ??= (async () => {
    if (await SecureStore.getItemAsync(UPGRADED, OPTIONS)) return;
    for (const key of Object.values(KEYS)) {
      const value = await SecureStore.getItemAsync(key, OPTIONS);
      if (value) await put(key, value);
    }
    await put(UPGRADED, '1');
  })().catch(() => {
    upgrade = null; // e.g. read while locked before first unlock: retry next time
  });
  return upgrade;
}

export const keystore = {
  async loadDevice(): Promise<StoredDevice | null> {
    await upgradeOnce();
    const [deviceId, secretKey] = await Promise.all([
      SecureStore.getItemAsync(KEYS.deviceId, OPTIONS),
      SecureStore.getItemAsync(KEYS.secretKey, OPTIONS),
    ]);
    return deviceId && secretKey ? { deviceId, secretKey } : null;
  },
  async saveDevice(device: StoredDevice): Promise<void> {
    await put(KEYS.secretKey, device.secretKey);
    await put(KEYS.deviceId, device.deviceId);
  },
  loadRefreshToken: () => SecureStore.getItemAsync(KEYS.refreshToken, OPTIONS),
  saveRefreshToken: (token: string) => put(KEYS.refreshToken, token),
  /** Remove everything that could authenticate as this device. */
  async wipe(): Promise<void> {
    await Promise.all(Object.values(KEYS).map((k) => SecureStore.deleteItemAsync(k, OPTIONS)));
  },
};
