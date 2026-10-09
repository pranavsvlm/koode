import {
  KeyDeviceList,
  KeyStatus,
  OkResponse,
  PreKeyBundleList,
  type FileSecret,
} from '@koode/shared';
import Storage from 'expo-sqlite/kv-store';
import { KoodeSignal } from '../../../modules/koode-signal';
import { authClient } from '@/features/auth';
import { createDeviceCrypto, type DeviceCrypto, type KeysApi } from './deviceCrypto';

const keysApi: KeysApi = {
  status: () => authClient.request('/v1/keys/status', KeyStatus),
  publish: (body) => authClient.request('/v1/keys', OkResponse, { method: 'PUT', body }),
  uploadOneTime: (body) =>
    authClient.request('/v1/keys/one-time', OkResponse, { method: 'POST', body }),
  devices: async (userIds) =>
    (
      await authClient.request(
        `/v1/keys/devices?userIds=${userIds.map(encodeURIComponent).join(',')}`,
        KeyDeviceList,
      )
    ).devices,
  bundle: async (userId, deviceId) =>
    (
      await authClient.request(
        `/v1/keys/${encodeURIComponent(userId)}/${deviceId}`,
        PreKeyBundleList,
      )
    ).bundles,
};

const storage = {
  get: (key: string) => Storage.getItem(key),
  set: (key: string, value: string) => Storage.setItem(key, value),
  remove: (key: string) => Storage.removeItem(key),
};

/** libsignal, or a clear error where the native module isn't available. */
function native() {
  if (!KoodeSignal) throw new Error('End-to-end encryption isn’t available in this build');
  return KoodeSignal;
}

let current: { userId: string; crypto: DeviceCrypto } | null = null;

/** The signed-in account's device crypto (one per account). */
export function deviceCrypto(userId: string): DeviceCrypto {
  if (current?.userId !== userId)
    current = {
      userId,
      crypto: createDeviceCrypto({ userId, native: native(), api: keysApi, storage }),
    };
  return current.crypto;
}

/** Sign-out: erase keys and sessions (also when no account is loaded). */
export async function resetDeviceCrypto(): Promise<void> {
  const c = current;
  current = null;
  if (c) await c.crypto.reset();
  else if (KoodeSignal) await KoodeSignal.reset();
}

/** Encrypt a file for upload (AES-256-GCM with a fresh key); returns the key and digest. */
export async function encryptFile(
  inputUri: string,
  outputUri: string,
): Promise<FileSecret & { size: number }> {
  const r = await native().encryptFile(inputUri, outputUri);
  return { key: r.key, digest: r.digest, size: Number(r.size) };
}

/** Check the ciphertext digest, then decrypt. Throws if the file was altered. */
export function decryptFile(inputUri: string, outputUri: string, secret: FileSecret) {
  return native().decryptFile(inputUri, outputUri, secret.key, secret.digest);
}

/** 32 random bytes (base64) for a call's media key. */
export const randomKey = () => native().randomKey();

export { IdentityChangedError, KeysLostError, type DeviceCrypto } from './deviceCrypto';
