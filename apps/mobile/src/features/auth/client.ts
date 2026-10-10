import {
  AuthSession,
  authSigningMessage,
  ChallengeResponse,
  CreatedInvite,
  DeviceList,
  InviteList,
  InvitePreview,
  OkResponse,
  TokenPair,
  User,
  UsernameAvailability,
  type ChallengePurpose,
} from '@koode/shared';
import type { z } from 'zod';
import { ApiClientError, apiRequest, type ApiRequestOptions } from '@/lib/api';
import { generateDeviceKey, signMessage } from './crypto';
import type { StoredDevice } from './keystore';

/** Renew access tokens this long before they expire. */
const RENEW_MARGIN_MS = 60_000;

export type AuthClientDeps = {
  request: typeof apiRequest;
  keystore: {
    loadDevice: () => Promise<StoredDevice | null>;
    saveDevice: (d: StoredDevice) => Promise<void>;
    loadRefreshToken: () => Promise<string | null>;
    saveRefreshToken: (t: string) => Promise<void>;
    wipe: () => Promise<void>;
  };
  randomBytes: (n: number) => Uint8Array;
  deviceInfo: () => { name: string; platform: 'ios' | 'android' };
  now?: () => number;
};

/** Thrown when this device can no longer authenticate (revoked or wiped). */
export class SignedOutError extends Error {
  constructor() {
    super('Signed out');
    this.name = 'SignedOutError';
  }
}

export function createAuthClient(deps: AuthClientDeps) {
  const now = deps.now ?? Date.now;
  let access: { token: string; expiresAt: number } | null = null;
  let renewing: Promise<string> | null = null;
  let onSignedOut: () => void = () => {};

  const post = <T>(
    path: string,
    schema: z.ZodType<T>,
    body: unknown,
    opts: ApiRequestOptions = {},
  ) => deps.request(path, schema, { ...opts, method: 'POST', body });

  async function signedChallenge(purpose: ChallengePurpose, subject: string, secretKey: string) {
    const { nonce } = await post('/v1/auth/challenge', ChallengeResponse, { purpose });
    return {
      nonce,
      signature: signMessage(secretKey, authSigningMessage(purpose, nonce, subject)),
    };
  }

  async function adopt(tokens: TokenPair) {
    access = { token: tokens.accessToken, expiresAt: tokens.accessTokenExpiresAt };
    await deps.keystore.saveRefreshToken(tokens.refreshToken);
  }

  async function enrol(
    purpose: 'register' | 'recover',
    path: string,
    body: Record<string, unknown>,
  ) {
    const key = generateDeviceKey(deps.randomBytes);
    const proof = await signedChallenge(purpose, key.publicKey, key.secretKey);
    const session = await post(path, AuthSession, {
      ...body,
      device: { ...deps.deviceInfo(), signingPublicKey: key.publicKey },
      ...proof,
    });
    // Persist the key before anything else, so a crash can't orphan the account.
    await deps.keystore.saveDevice({ deviceId: session.deviceId, secretKey: key.secretKey });
    await adopt(session);
    return session;
  }

  async function signOutLocally() {
    access = null;
    await deps.keystore.wipe();
    onSignedOut();
  }

  /** Sign in again with the device key (used when the refresh token is gone or rejected). */
  async function loginWithDeviceKey(): Promise<string> {
    const device = await deps.keystore.loadDevice();
    if (!device) throw new SignedOutError();
    try {
      const proof = await signedChallenge('login', device.deviceId, device.secretKey);
      const session = await post('/v1/auth/login', AuthSession, {
        deviceId: device.deviceId,
        ...proof,
      });
      await adopt(session);
      return session.accessToken;
    } catch (e) {
      if (e instanceof ApiClientError && e.code === 'unauthorized') {
        // The server no longer accepts this device (revoked from another device, or wiped).
        await signOutLocally();
        throw new SignedOutError();
      }
      throw e; // offline etc.: keep the device, try again later
    }
  }

  async function renew(): Promise<string> {
    const refreshToken = await deps.keystore.loadRefreshToken();
    if (refreshToken) {
      try {
        const pair = await post('/v1/auth/refresh', TokenPair, { refreshToken });
        await adopt(pair);
        return pair.accessToken;
      } catch (e) {
        if (!(e instanceof ApiClientError && e.code === 'unauthorized')) throw e;
      }
    }
    return loginWithDeviceKey();
  }

  /** A valid access token, renewing at most once at a time. */
  async function getAccessToken(): Promise<string> {
    if (access && access.expiresAt - RENEW_MARGIN_MS > now()) return access.token;
    renewing ??= renew().finally(() => {
      renewing = null;
    });
    return renewing;
  }

  /** Authenticated request; a 401 triggers one renewal and retry. */
  async function authed<T>(
    path: string,
    schema: z.ZodType<T>,
    opts: ApiRequestOptions = {},
  ): Promise<T> {
    const token = await getAccessToken();
    try {
      return await deps.request(path, schema, { ...opts, token });
    } catch (e) {
      if (!(e instanceof ApiClientError && e.code === 'unauthorized')) throw e;
      access = null;
      return deps.request(path, schema, { ...opts, token: await getAccessToken() });
    }
  }

  return {
    setOnSignedOut(fn: () => void) {
      onSignedOut = fn;
    },
    hasDevice: async () => (await deps.keystore.loadDevice()) !== null,

    register: (input: {
      inviteCode: string;
      username: string;
      displayName: string;
      recoveryKey: string;
    }) => enrol('register', '/v1/auth/register', input),
    recover: (input: { username: string; recoveryKey: string }) =>
      enrol('recover', '/v1/auth/recover', input),

    /** Sign out = remove this device on the server, then wipe local secrets. */
    async logout() {
      try {
        if (access || (await deps.keystore.loadRefreshToken())) {
          await authed('/v1/auth/logout', OkResponse, { method: 'POST', body: {} });
        }
      } catch {
        // Best effort: local secrets are wiped regardless.
      } finally {
        access = null;
        await deps.keystore.wipe();
      }
    },

    /** Permanently delete the account (server side), then wipe this device's secrets. */
    async deleteAccount() {
      await authed('/v1/me', OkResponse, { method: 'DELETE', body: { confirm: 'DELETE' } });
      access = null;
      await deps.keystore.wipe();
    },

    getAccessToken,
    /** Authenticated request with automatic renewal (used by messaging). */
    request: authed,
    me: () => authed('/v1/me', User),
    updateProfile: (patch: { displayName?: string; about?: string }) =>
      authed('/v1/me', User, { method: 'PATCH', body: patch }),
    rotateRecoveryKey: (recoveryKey: string) =>
      authed('/v1/me/recovery-key', OkResponse, { method: 'PUT', body: { recoveryKey } }),

    devices: async () => (await authed('/v1/devices', DeviceList)).devices,
    renameDevice: (id: string, name: string) =>
      authed(`/v1/devices/${encodeURIComponent(id)}`, OkResponse, {
        method: 'PATCH',
        body: { name },
      }),
    revokeDevice: (id: string) =>
      authed(`/v1/devices/${encodeURIComponent(id)}`, OkResponse, { method: 'DELETE' }),

    createInvite: (expiresInDays = 7) =>
      authed('/v1/invites', CreatedInvite, { method: 'POST', body: { expiresInDays } }),
    invites: async () => (await authed('/v1/invites', InviteList)).invites,
    revokeInvite: (id: string) =>
      authed(`/v1/invites/${encodeURIComponent(id)}`, OkResponse, { method: 'DELETE' }),

    // Public endpoints (no session needed).
    previewInvite: (code: string) =>
      deps.request(`/v1/invites/preview?code=${encodeURIComponent(code)}`, InvitePreview),
    usernameAvailable: (username: string) =>
      deps.request(`/v1/auth/username/${encodeURIComponent(username)}`, UsernameAvailability),
  };
}

export type AuthClient = ReturnType<typeof createAuthClient>;
