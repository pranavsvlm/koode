import type {
  DeviceMismatch,
  Envelope,
  KeyDevice,
  KeyStatus,
  OutgoingEnvelope,
  PreKeyBundle,
  PublishKeysRequest,
  UploadOneTimeKeysRequest,
} from '@koode/shared';

/**
 * This device's side of end-to-end encryption: keeps its keys published,
 * starts sessions with other devices from their published bundles, and
 * encrypts / decrypts with libsignal (the native module). Plaintext and
 * private keys never leave the device.
 */

/** The native libsignal surface (KoodeSignal), injectable for tests. */
export type SignalNative = {
  ensureIdentity(): Promise<{ identityKey: string; registrationId: number; created: boolean }>;
  generatePreKeys(startId: number, count: number): Promise<{ keyId: number; publicKey: string }[]>;
  generateSignedPreKey(
    id: number,
  ): Promise<{ keyId: number; publicKey: string; signature?: string }>;
  generateKyberPreKeys(
    startId: number,
    count: number,
    lastResort: boolean,
  ): Promise<{ keyId: number; publicKey: string; signature?: string }[]>;
  hasSession(name: string, deviceId: number): Promise<boolean>;
  processBundle(
    name: string,
    bundle: Omit<PreKeyBundle, 'userId'> & { localName: string },
  ): Promise<void>;
  encrypt(
    localName: string,
    plaintext: string,
    recipients: { name: string; deviceId: number }[],
  ): Promise<{ name: string; deviceId: number; type: number; body: string }[]>;
  decrypt(
    localName: string,
    name: string,
    deviceId: number,
    type: number,
    body: string,
  ): Promise<string>;
  remoteIdentity(name: string, deviceId: number): Promise<string | null>;
  forgetIdentity(name: string, deviceId: number): Promise<void>;
  fingerprint(
    localId: string,
    remoteId: string,
    remoteIdentityKey: string,
  ): Promise<{ displayable: string; scannable: string }>;
  reset(): Promise<void>;
};

export type KeysApi = {
  status(): Promise<KeyStatus>;
  publish(body: PublishKeysRequest): Promise<unknown>;
  uploadOneTime(body: UploadOneTimeKeysRequest): Promise<unknown>;
  devices(userIds: string[]): Promise<KeyDevice[]>;
  bundle(userId: string, deviceId: number): Promise<PreKeyBundle[]>;
};

/** Small non-secret state (key id counters, verifications). */
export type CryptoStorage = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
};

/** A known device presented a different identity key: never silently accepted. */
export class IdentityChangedError extends Error {
  constructor(
    readonly userId: string,
    readonly deviceId: number,
  ) {
    super('Safety number changed');
    this.name = 'IdentityChangedError';
  }
}

/** The keys on this device don't match the ones the server has for it. */
export class KeysLostError extends Error {
  constructor() {
    super('This device’s encryption keys were lost. Sign out and in again.');
    this.name = 'KeysLostError';
  }
}

export const PREKEY_BATCH = 100;
/** Top up when fewer than this many one-time keys remain on the server. */
export const PREKEY_LOW = 25;
export const SIGNED_PREKEY_MAX_AGE_MS = 30 * 24 * 3600_000;
const DEVICE_CACHE_MS = 10 * 60_000;
/** libsignal key ids are 24-bit; the last-resort Kyber key sits apart from one-time ones. */
const MAX_KEY_ID = 0xffffff;
const LAST_RESORT_KYBER_BASE = 0xf00000;

type State = {
  /** Counters for the next one-time key ids (wrap within 24 bits). */
  nextPreKeyId: number;
  nextKyberId: number;
  signedPreKeyId: number;
  signedPreKeyAt: number;
};

const STATE_KEY = 'koode.signal.state';
/** userId → the device fingerprints ("deviceId:identityKey") that were verified. */
const VERIFIED_KEY = 'koode.signal.verified';

export type Verification = 'verified' | 'unverified' | 'changed';

export function createDeviceCrypto(deps: {
  userId: string;
  native: SignalNative;
  api: KeysApi;
  storage: CryptoStorage;
  now?: () => number;
}) {
  const { userId, native, api, storage } = deps;
  const now = deps.now ?? Date.now;

  // libsignal calls are serialized natively; serializing here too keeps
  // "check session → fetch bundle → encrypt" atomic per device.
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  let me: Promise<{ deviceId: number; localName: string }> | null = null;
  const devices = new Map<string, { list: KeyDevice[]; at: number }>();

  const loadState = async (): Promise<State | null> => {
    const raw = await storage.get(STATE_KEY);
    return raw ? (JSON.parse(raw) as State) : null;
  };
  const saveState = (s: State) => storage.set(STATE_KEY, JSON.stringify(s));
  const loadVerified = async (): Promise<Record<string, string[]>> => {
    const raw = await storage.get(VERIFIED_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
  };
  const fingerprints = (list: KeyDevice[]) =>
    list.map((d) => `${d.deviceId}:${d.identityKey}`).sort();
  const wrap = (id: number) => ((id - 1) % (LAST_RESORT_KYBER_BASE - 1)) + 1;

  /**
   * Publish keys once per device; afterwards keep one-time keys topped up and
   * rotate the signed prekey monthly.
   */
  async function bootstrap(): Promise<{ deviceId: number; localName: string }> {
    const status = await api.status();
    const localName = `${userId}.${status.deviceId}`;
    if (!status.published) {
      // A new server device: start from a fresh identity, so nothing from a
      // previous sign-in (Keychain items can survive reinstalls) carries over.
      await native.reset();
      await storage.remove(STATE_KEY);
      const identity = await native.ensureIdentity();
      const signedPreKey = await native.generateSignedPreKey(1);
      const [lastResort] = await native.generateKyberPreKeys(LAST_RESORT_KYBER_BASE, 1, true);
      const preKeys = await native.generatePreKeys(1, PREKEY_BATCH);
      const kyberPreKeys = await native.generateKyberPreKeys(1, PREKEY_BATCH, false);
      await api.publish({
        registrationId: identity.registrationId,
        identityKey: identity.identityKey,
        signedPreKey: { ...signedPreKey, signature: signedPreKey.signature! },
        kyberPreKey: { ...lastResort!, signature: lastResort!.signature! },
        preKeys,
        kyberPreKeys: kyberPreKeys.map((k) => ({ ...k, signature: k.signature! })),
      });
      await saveState({
        nextPreKeyId: PREKEY_BATCH + 1,
        nextKyberId: PREKEY_BATCH + 1,
        signedPreKeyId: 1,
        signedPreKeyAt: now(),
      });
      return { deviceId: status.deviceId, localName };
    }

    const identity = await native.ensureIdentity();
    const state = await loadState();
    if (identity.created || identity.identityKey !== status.identityKey || !state) {
      // The server has keys for this device that this Keychain doesn't.
      throw new KeysLostError();
    }
    await replenish(status, state, identity);
    return { deviceId: status.deviceId, localName };
  }

  async function replenish(
    status: KeyStatus,
    state: State,
    identity: { identityKey: string; registrationId: number },
  ) {
    const upload: UploadOneTimeKeysRequest = {};
    let next = { ...state };
    if (status.preKeys < PREKEY_LOW) {
      upload.preKeys = await native.generatePreKeys(wrap(next.nextPreKeyId), PREKEY_BATCH);
      next.nextPreKeyId = wrap(next.nextPreKeyId + PREKEY_BATCH);
    }
    if (status.kyberPreKeys < PREKEY_LOW) {
      const keys = await native.generateKyberPreKeys(wrap(next.nextKyberId), PREKEY_BATCH, false);
      upload.kyberPreKeys = keys.map((k) => ({ ...k, signature: k.signature! }));
      next.nextKyberId = wrap(next.nextKyberId + PREKEY_BATCH);
    }
    if (upload.preKeys || upload.kyberPreKeys) {
      await saveState(next); // ids are never reused, even if the upload fails
      await api.uploadOneTime(upload);
    }
    if (now() - next.signedPreKeyAt > SIGNED_PREKEY_MAX_AGE_MS) {
      const id = (next.signedPreKeyId % MAX_KEY_ID) + 1;
      const signedPreKey = await native.generateSignedPreKey(id);
      const [lastResort] = await native.generateKyberPreKeys(
        LAST_RESORT_KYBER_BASE + (id % 0xfff),
        1,
        true,
      );
      next = { ...next, signedPreKeyId: id, signedPreKeyAt: now() };
      await saveState(next);
      // Same identity; the server swaps the signed and last-resort keys.
      await api.publish({
        registrationId: identity.registrationId,
        identityKey: identity.identityKey,
        signedPreKey: { ...signedPreKey, signature: signedPreKey.signature! },
        kyberPreKey: { ...lastResort!, signature: lastResort!.signature! },
      });
    }
  }

  /** Bootstraps once; a failure (offline) is retried on the next call. */
  const ready = () =>
    (me ??= bootstrap().catch((e: unknown) => {
      me = null;
      throw e;
    }));

  let topUp: Promise<void> | null = null;
  /** After using up prekeys (someone started a session with me). */
  const scheduleTopUp = () => {
    topUp ??= (async () => {
      try {
        const [status, state, identity] = await Promise.all([
          api.status(),
          loadState(),
          native.ensureIdentity(),
        ]);
        if (state) await locked(() => replenish(status, state, identity));
      } catch {
        // next decrypt or start-up tries again
      } finally {
        topUp = null;
      }
    })();
  };

  async function devicesOf(userIds: string[], fresh = false): Promise<KeyDevice[]> {
    const stale = userIds.filter((u) => {
      const c = devices.get(u);
      return fresh || !c || now() - c.at > DEVICE_CACHE_MS;
    });
    if (stale.length) {
      const list = await api.devices(stale);
      for (const u of stale)
        devices.set(u, { list: list.filter((d) => d.userId === u), at: now() });
    }
    return userIds.flatMap((u) => devices.get(u)?.list ?? []);
  }

  /** Make sure a session exists with each device (fetching its bundle if not). */
  async function sessions(localName: string, targets: KeyDevice[]) {
    for (const d of targets) {
      const known = await native.remoteIdentity(d.userId, d.deviceId);
      if (known && known !== d.identityKey) throw new IdentityChangedError(d.userId, d.deviceId);
      if (await native.hasSession(d.userId, d.deviceId)) continue;
      const [bundle] = await api.bundle(d.userId, d.deviceId);
      if (!bundle) continue; // gone since the list was fetched; the server will say
      if (bundle.identityKey !== d.identityKey)
        throw new IdentityChangedError(d.userId, d.deviceId);
      const { userId: _u, ...rest } = bundle;
      await native.processBundle(d.userId, { ...rest, localName });
    }
  }

  return {
    /** Publish / top up keys now (call at sign-in and app start). */
    start: () => ready().then(() => undefined),

    /** This device's Signal number (to pick its envelope from a message). */
    deviceId: async () => (await ready()).deviceId,

    /**
     * Encrypt for every device of these people (including my other devices),
     * except this one.
     */
    encrypt: (userIds: string[], plaintext: string): Promise<OutgoingEnvelope[]> =>
      locked(async () => {
        const self = await ready();
        const targets = (await devicesOf([...new Set(userIds)])).filter(
          (d) => !(d.userId === userId && d.deviceId === self.deviceId),
        );
        if (targets.length === 0) return [];
        await sessions(self.localName, targets);
        const out = await native.encrypt(
          self.localName,
          plaintext,
          targets.map((d) => ({ name: d.userId, deviceId: d.deviceId })),
        );
        return out.map((e) => ({
          userId: e.name,
          deviceId: e.deviceId,
          type: e.type as 2 | 3,
          body: e.body,
        }));
      }),

    /** The server said devices changed: reload those people's device lists. */
    refresh: async (mismatch: DeviceMismatch | null, userIds: string[] = []) => {
      const affected = new Set([
        ...userIds,
        ...(mismatch?.missing ?? []).map((d) => d.userId),
        ...(mismatch?.extra ?? []).map((d) => d.userId),
      ]);
      for (const u of affected) devices.delete(u);
    },

    decrypt: (senderId: string, senderDevice: number, envelope: Envelope): Promise<string> =>
      locked(async () => {
        const self = await ready();
        const text = await native.decrypt(
          self.localName,
          senderId,
          senderDevice,
          envelope.type,
          envelope.body,
        );
        if (envelope.type === 3) scheduleTopUp();
        return text;
      }),

    /** Someone's devices with keys (fresh from the server). */
    devices: (forUserId: string) => devicesOf([forUserId], true),

    /** Safety number between this device and one of theirs. */
    safetyNumber: (remoteId: string, identityKey: string) =>
      native.fingerprint(userId, remoteId, identityKey),

    /** Mark someone's current devices verified (after comparing safety numbers). */
    async setVerified(forUserId: string, verified: boolean) {
      const all = await loadVerified();
      if (verified) all[forUserId] = fingerprints(await devicesOf([forUserId], true));
      else delete all[forUserId];
      await storage.set(VERIFIED_KEY, JSON.stringify(all));
    },

    /** Verified, or verified before but their devices have changed since. */
    async verification(forUserId: string, list?: KeyDevice[]): Promise<Verification> {
      const verified = (await loadVerified())[forUserId];
      if (!verified) return 'unverified';
      const current = fingerprints(list ?? (await devicesOf([forUserId])));
      return current.join() === verified.join() ? 'verified' : 'changed';
    },

    /** Accept a device's changed identity (after warning the user). */
    acceptIdentity: (forUserId: string, deviceId: number) =>
      locked(async () => {
        await native.forgetIdentity(forUserId, deviceId);
        devices.delete(forUserId);
      }),

    /** Sign-out: every key and session on this device. */
    reset: () =>
      locked(async () => {
        me = null;
        devices.clear();
        await native.reset();
        await storage.remove(STATE_KEY);
        await storage.remove(VERIFIED_KEY);
      }),
  };
}

export type DeviceCrypto = ReturnType<typeof createDeviceCrypto>;
