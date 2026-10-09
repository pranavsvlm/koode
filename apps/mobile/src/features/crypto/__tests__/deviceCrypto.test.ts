import type { KeyDevice, KeyStatus, PreKeyBundle, PublishKeysRequest } from '@koode/shared';
import {
  createDeviceCrypto,
  IdentityChangedError,
  KeysLostError,
  PREKEY_BATCH,
  SIGNED_PREKEY_MAX_AGE_MS,
  type CryptoStorage,
  type KeysApi,
  type SignalNative,
} from '../deviceCrypto';

const ME = 'usr_me';
const MAYA = 'usr_maya';

/** libsignal stand-in that records what it was asked to do. */
function fakeNative() {
  const state = {
    identity: null as string | null,
    sessions: new Set<string>(),
    identities: new Map<string, string>(),
    bundles: [] as string[],
    resets: 0,
    preKeys: [] as number[],
  };
  const native: SignalNative = {
    ensureIdentity: async () => {
      const created = !state.identity;
      state.identity ??= `id-${Math.random()}`;
      return { identityKey: state.identity, registrationId: 42, created };
    },
    generatePreKeys: async (start, count) => {
      state.preKeys.push(start);
      return Array.from({ length: count }, (_, i) => ({ keyId: start + i, publicKey: 'cGs=' }));
    },
    generateSignedPreKey: async (id) => ({ keyId: id, publicKey: 'c3Br', signature: 'c2ln' }),
    generateKyberPreKeys: async (start, count) =>
      Array.from({ length: count }, (_, i) => ({
        keyId: start + i,
        publicKey: 'a3li',
        signature: 'c2ln',
      })),
    hasSession: async (name, device) => state.sessions.has(`${name}.${device}`),
    processBundle: async (name, b) => {
      state.bundles.push(`${name}.${b.deviceId}`);
      state.sessions.add(`${name}.${b.deviceId}`);
      state.identities.set(`${name}.${b.deviceId}`, b.identityKey);
    },
    encrypt: async (_local, plain, recipients) =>
      recipients.map((r) => ({ ...r, type: 2, body: btoa(plain) })),
    decrypt: async (_l, _n, _d, _t, body) => atob(body),
    remoteIdentity: async (name, device) => state.identities.get(`${name}.${device}`) ?? null,
    forgetIdentity: async (name, device) => {
      state.identities.delete(`${name}.${device}`);
      state.sessions.delete(`${name}.${device}`);
    },
    fingerprint: async () => ({ displayable: '1'.repeat(60), scannable: '' }),
    reset: async () => {
      state.resets++;
      state.identity = null;
      state.sessions.clear();
      state.identities.clear();
    },
  };
  return { native, state };
}

function fakeServer() {
  const state = {
    status: {
      deviceId: 2,
      published: false,
      identityKey: null,
      preKeys: 0,
      kyberPreKeys: 0,
    } as KeyStatus,
    published: [] as PublishKeysRequest[],
    uploads: 0,
    devices: [
      { userId: MAYA, deviceId: 1, identityKey: 'maya-1' },
      { userId: ME, deviceId: 1, identityKey: 'me-1' },
      { userId: ME, deviceId: 2, identityKey: 'me-2' },
    ] as KeyDevice[],
    bundleFetches: [] as string[],
  };
  const api: KeysApi = {
    status: async () => state.status,
    publish: async (body) => {
      state.published.push(body);
      state.status = {
        ...state.status,
        published: true,
        identityKey: body.identityKey,
        preKeys: body.preKeys?.length ?? state.status.preKeys,
        kyberPreKeys: body.kyberPreKeys?.length ?? state.status.kyberPreKeys,
      };
      return {};
    },
    uploadOneTime: async () => {
      state.uploads++;
      return {};
    },
    devices: async (ids) => state.devices.filter((d) => ids.includes(d.userId)),
    bundle: async (userId, deviceId) => {
      state.bundleFetches.push(`${userId}.${deviceId}`);
      const d = state.devices.find((x) => x.userId === userId && x.deviceId === deviceId);
      if (!d) return [];
      const bundle: PreKeyBundle = {
        userId,
        deviceId,
        registrationId: 7,
        identityKey: d.identityKey,
        signedPreKey: { keyId: 1, publicKey: 'c3Br', signature: 'c2ln' },
        kyberPreKey: { keyId: 1, publicKey: 'a3li', signature: 'c2ln' },
        preKey: null,
      };
      return [bundle];
    },
  };
  return { api, state };
}

function memoryStorage(): CryptoStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => void data.set(k, v),
    remove: async (k) => void data.delete(k),
  };
}

function setup(now = () => 1_000) {
  const n = fakeNative();
  const s = fakeServer();
  const storage = memoryStorage();
  const make = () => createDeviceCrypto({ userId: ME, native: n.native, api: s.api, storage, now });
  return { n, s, storage, crypto: make(), make };
}

describe('device crypto', () => {
  it('publishes a fresh identity and prekeys for a new device', async () => {
    const t = setup();
    t.n.state.identity = 'left-over-from-an-earlier-install';
    await t.crypto.start();
    expect(t.n.state.resets).toBe(1); // nothing carries over
    const [published] = t.s.state.published;
    expect(published).toMatchObject({ registrationId: 42, signedPreKey: { keyId: 1 } });
    expect(published!.identityKey).not.toBe('left-over-from-an-earlier-install');
    expect(published!.preKeys).toHaveLength(PREKEY_BATCH);
    expect(published!.kyberPreKeys).toHaveLength(PREKEY_BATCH);
    expect(await t.crypto.deviceId()).toBe(2);
  });

  it('refuses to carry on if the server has keys this device lost', async () => {
    const t = setup();
    await t.crypto.start();
    t.n.state.identity = null; // e.g. Keychain wiped
    await expect(t.make().start()).rejects.toBeInstanceOf(KeysLostError);
  });

  it('tops up one-time keys with new ids and rotates the signed prekey monthly', async () => {
    let clock = 1_000;
    const t = setup(() => clock);
    await t.crypto.start();
    t.s.state.status = { ...t.s.state.status, preKeys: 3, kyberPreKeys: 50 };
    clock += SIGNED_PREKEY_MAX_AGE_MS + 1;
    await t.make().start();
    expect(t.s.state.uploads).toBe(1);
    expect(t.n.state.preKeys).toEqual([1, PREKEY_BATCH + 1]); // never reused
    expect(t.s.state.published.at(-1)).toMatchObject({ signedPreKey: { keyId: 2 } });
  });

  it('starts sessions only where needed, for every device but this one', async () => {
    const t = setup();
    const out = await t.crypto.encrypt([MAYA, ME], 'hi');
    expect(out.map((e) => `${e.userId}.${e.deviceId}`)).toEqual([`${MAYA}.1`, `${ME}.1`]);
    expect(t.s.state.bundleFetches).toEqual([`${MAYA}.1`, `${ME}.1`]);
    await t.crypto.encrypt([MAYA], 'again');
    expect(t.s.state.bundleFetches).toHaveLength(2); // sessions exist now
    expect(atob(out[0]!.body)).toBe('hi');
  });

  it('never accepts a changed identity silently', async () => {
    const t = setup();
    await t.crypto.encrypt([MAYA], 'hi');
    t.s.state.devices[0] = { ...t.s.state.devices[0]!, identityKey: 'someone-else' };
    await t.crypto.refresh(null, [MAYA]);
    await expect(t.crypto.encrypt([MAYA], 'hi')).rejects.toBeInstanceOf(IdentityChangedError);
    // The user accepts the new key: a new session with the new identity.
    await t.crypto.acceptIdentity(MAYA, 1);
    await expect(t.crypto.encrypt([MAYA], 'hi')).resolves.toHaveLength(1);
  });

  it('tracks verification, and notices when verified devices change', async () => {
    const t = setup();
    expect(await t.crypto.verification(MAYA)).toBe('unverified');
    await t.crypto.setVerified(MAYA, true);
    expect(await t.crypto.verification(MAYA)).toBe('verified');
    t.s.state.devices.push({ userId: MAYA, deviceId: 2, identityKey: 'maya-2' });
    expect(await t.crypto.verification(MAYA, await t.crypto.devices(MAYA))).toBe('changed');
  });

  it('erases everything at sign-out', async () => {
    const t = setup();
    await t.crypto.start();
    await t.crypto.setVerified(MAYA, true);
    await t.crypto.reset();
    expect(t.storage.data.size).toBe(0);
    expect(t.n.state.identity).toBeNull();
  });
});
