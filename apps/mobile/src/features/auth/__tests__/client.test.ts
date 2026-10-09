import { authSigningMessage } from '@koode/shared';
import { ApiClientError, type apiRequest } from '@/lib/api';
import { createAuthClient, SignedOutError } from '../client';
import { verifyMessage } from '../crypto';
import type { StoredDevice } from '../keystore';

/**
 * In-memory fake of the auth API. It verifies real Ed25519 signatures, so the
 * client's key handling is exercised end to end (minus HTTP).
 */
function fakeServer() {
  const state = {
    nonces: new Set<string>(),
    devices: new Map<string, { publicKey: string; revoked: boolean }>(),
    refresh: new Map<string, string>(), // token -> deviceId
    access: new Map<string, number>(), // token -> expiresAt
    online: true,
    calls: [] as string[],
    n: 0,
  };
  const user = { id: 'usr_1', username: 'maya', displayName: 'Maya', about: '', createdAt: 0 };
  const issue = (deviceId: string, expiresAt = Date.now() + 15 * 60_000) => {
    const accessToken = `at${++state.n}`;
    const refreshToken = `rt-${'x'.repeat(24)}-${state.n}`;
    state.access.set(accessToken, expiresAt);
    state.refresh.set(refreshToken, deviceId);
    return { user, deviceId, accessToken, accessTokenExpiresAt: expiresAt, refreshToken };
  };
  const unauthorized = () => new ApiClientError('unauthorized', 'nope', 401);

  const request = (async (
    path: string,
    schema: { parse: (v: unknown) => unknown },
    init: { body?: unknown; token?: string } = {},
  ) => {
    state.calls.push(path);
    if (!state.online) throw new ApiClientError('network', 'offline');
    const body = (init.body ?? {}) as Record<string, string & { signingPublicKey: string }>;
    const consume = (nonce: string) => {
      if (!state.nonces.delete(nonce)) throw unauthorized();
    };
    let result: unknown;
    switch (path) {
      case '/v1/auth/challenge': {
        const nonce = `nonce-${'n'.repeat(20)}-${++state.n}`;
        state.nonces.add(nonce);
        result = { nonce, expiresAt: Date.now() + 120_000 };
        break;
      }
      case '/v1/auth/register':
      case '/v1/auth/recover': {
        consume(body.nonce!);
        const pub = (body.device as unknown as { signingPublicKey: string }).signingPublicKey;
        const purpose = path.endsWith('register') ? 'register' : 'recover';
        if (!verifyMessage(pub, authSigningMessage(purpose, body.nonce!, pub), body.signature!))
          throw unauthorized();
        const deviceId = `dev_${++state.n}`;
        state.devices.set(deviceId, { publicKey: pub, revoked: false });
        result = issue(deviceId);
        break;
      }
      case '/v1/auth/login': {
        consume(body.nonce!);
        const d = state.devices.get(body.deviceId!);
        if (
          !d ||
          d.revoked ||
          !verifyMessage(
            d.publicKey,
            authSigningMessage('login', body.nonce!, body.deviceId!),
            body.signature!,
          )
        ) {
          throw unauthorized();
        }
        result = issue(body.deviceId!);
        break;
      }
      case '/v1/auth/refresh': {
        const deviceId = state.refresh.get(body.refreshToken!);
        state.refresh.delete(body.refreshToken!);
        if (!deviceId || state.devices.get(deviceId)?.revoked) throw unauthorized();
        result = issue(deviceId);
        break;
      }
      case '/v1/me': {
        const exp = init.token ? state.access.get(init.token) : undefined;
        if (!exp || exp < Date.now()) throw unauthorized();
        result = user;
        break;
      }
      default:
        throw new Error(`unexpected ${path}`);
    }
    return schema.parse(result);
  }) as unknown as typeof apiRequest;

  return { state, request };
}

function memoryKeystore() {
  const data: { device: StoredDevice | null; refresh: string | null } = {
    device: null,
    refresh: null,
  };
  return {
    data,
    loadDevice: async () => data.device,
    saveDevice: async (d: StoredDevice) => void (data.device = d),
    loadRefreshToken: async () => data.refresh,
    saveRefreshToken: async (t: string) => void (data.refresh = t),
    wipe: async () => {
      data.device = null;
      data.refresh = null;
    },
  };
}

let seed = 1;
const randomBytes = (n: number) =>
  Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed++) & 255);

function setup() {
  const server = fakeServer();
  const store = memoryKeystore();
  const client = createAuthClient({
    request: server.request,
    keystore: store,
    randomBytes,
    deviceInfo: () => ({ name: 'Test iPhone', platform: 'ios' }),
  });
  const signedOut = jest.fn();
  client.setOnSignedOut(signedOut);
  return { server, store, client, signedOut };
}

const registration = {
  inviteCode: 'K7QM4XRT9PWD',
  username: 'maya',
  displayName: 'Maya',
  recoveryKey: 'P4Y98RJRK0XWTX0YKB7TV8DC',
};

describe('auth client', () => {
  it('registers with a fresh device key and keeps secrets in the keystore', async () => {
    const { client, store, server } = setup();
    const session = await client.register(registration);
    expect(store.data.device).toEqual({
      deviceId: session.deviceId,
      secretKey: expect.any(String),
    });
    expect(store.data.refresh).toBe(session.refreshToken);
    // The server only ever saw the public key.
    const registered = [...server.state.devices.values()][0]!;
    expect(registered.publicKey).not.toBe(store.data.device!.secretKey);
    await expect(client.me()).resolves.toMatchObject({ username: 'maya' });
  });

  it('renews an expired access token with the refresh token', async () => {
    const { client, server } = setup();
    await client.register(registration);
    for (const k of server.state.access.keys()) server.state.access.set(k, 0); // expire
    await expect(client.me()).resolves.toBeTruthy();
    expect(server.state.calls).toContain('/v1/auth/refresh');
  });

  it('falls back to signing in with the device key when the refresh token is rejected', async () => {
    const { client, server, signedOut } = setup();
    await client.register(registration);
    server.state.refresh.clear();
    for (const k of server.state.access.keys()) server.state.access.set(k, 0);
    await expect(client.me()).resolves.toBeTruthy();
    expect(server.state.calls).toContain('/v1/auth/login');
    expect(signedOut).not.toHaveBeenCalled();
  });

  it('signs out and wipes secrets when the device has been revoked', async () => {
    const { client, server, store, signedOut } = setup();
    const session = await client.register(registration);
    server.state.devices.get(session.deviceId)!.revoked = true;
    for (const k of server.state.access.keys()) server.state.access.set(k, 0);
    await expect(client.me()).rejects.toBeInstanceOf(SignedOutError);
    expect(signedOut).toHaveBeenCalledTimes(1);
    expect(store.data).toEqual({ device: null, refresh: null });
  });

  it('keeps the device when offline', async () => {
    const { client, server, store, signedOut } = setup();
    await client.register(registration);
    for (const k of server.state.access.keys()) server.state.access.set(k, 0);
    server.state.online = false;
    await expect(client.me()).rejects.toMatchObject({ code: 'network' });
    expect(signedOut).not.toHaveBeenCalled();
    expect(store.data.device).not.toBeNull();
  });

  it('renews only once for concurrent requests', async () => {
    const { client, server } = setup();
    await client.register(registration);
    for (const k of server.state.access.keys()) server.state.access.set(k, 0);
    await Promise.all([client.me(), client.me(), client.me()]);
    expect(server.state.calls.filter((c) => c === '/v1/auth/refresh')).toHaveLength(1);
  });

  it('recovers onto a new device key', async () => {
    const { client, store } = setup();
    const session = await client.recover({
      username: 'maya',
      recoveryKey: registration.recoveryKey,
    });
    expect(store.data.device?.deviceId).toBe(session.deviceId);
  });

  it('logout wipes local secrets even if the server is unreachable', async () => {
    const { client, server, store } = setup();
    await client.register(registration);
    server.state.online = false;
    await client.logout();
    expect(store.data).toEqual({ device: null, refresh: null });
  });
});
