import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * Binary values are base64 strings; message plaintext is UTF-8 text. Device
 * addresses are (userId, deviceId); this device's "local name" is
 * "userId.deviceId".
 */
export type PublicPreKey = { keyId: number; publicKey: string; signature?: string };
export type Bundle = {
  /** This device as "userId.deviceId". */
  localName: string;
  deviceId: number;
  registrationId: number;
  identityKey: string;
  signedPreKey: PublicPreKey;
  kyberPreKey: PublicPreKey;
  preKey?: PublicPreKey | null;
};
export type Envelope = { name: string; deviceId: number; type: number; body: string };

type KoodeSignalModule = {
  ensureIdentity(): Promise<{ identityKey: string; registrationId: number; created: boolean }>;
  generatePreKeys(startId: number, count: number): Promise<PublicPreKey[]>;
  generateSignedPreKey(id: number): Promise<PublicPreKey>;
  generateKyberPreKeys(
    startId: number,
    count: number,
    lastResort: boolean,
  ): Promise<PublicPreKey[]>;
  hasSession(name: string, deviceId: number): Promise<boolean>;
  processBundle(name: string, bundle: Bundle): Promise<void>;
  encrypt(
    localName: string,
    plaintext: string,
    recipients: { name: string; deviceId: number }[],
  ): Promise<Envelope[]>;
  decrypt(
    localName: string,
    name: string,
    deviceId: number,
    type: number,
    body: string,
  ): Promise<string>;
  remoteIdentity(name: string, deviceId: number): Promise<string | null>;
  /** Accept a changed identity: forget the old key and session. */
  forgetIdentity(name: string, deviceId: number): Promise<void>;
  /** Safety number; identifiers are the two account ids. */
  fingerprint(
    localId: string,
    remoteId: string,
    remoteIdentityKey: string,
  ): Promise<{ displayable: string; scannable: string }>;
  encryptFile(
    inputUri: string,
    outputUri: string,
  ): Promise<{ key: string; digest: string; size: string }>;
  decryptFile(inputUri: string, outputUri: string, key: string, digest: string): Promise<void>;
  randomKey(): Promise<string>;
  reset(): Promise<void>;
};

/** libsignal (iOS/Android). Null in tests and on unsupported platforms. */
export const KoodeSignal = requireOptionalNativeModule<KoodeSignalModule>('KoodeSignal');
