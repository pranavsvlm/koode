import { SELF, env } from 'cloudflare:test';
import { authSigningMessage, type AuthSession, type ChallengePurpose } from '@koode/shared';

const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type TestDevice = { publicKey: string; sign: (message: string) => Promise<string> };

export async function newDevice(): Promise<TestDevice> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer;
  return {
    publicKey: b64url(raw),
    sign: async (message) =>
      b64url(await crypto.subtle.sign('Ed25519', pair.privateKey, enc.encode(message))),
  };
}

export async function api(
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
) {
  const res = await SELF.fetch(`https://api.test/v1${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers: {
      ...(init.body !== undefined && { 'content-type': 'application/json' }),
      ...(init.token && { authorization: `Bearer ${init.token}` }),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  // Untyped on purpose: tests assert on shapes or parse with the shared schemas.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = (await res.json().catch(() => null)) as any;
  return { status: res.status, json };
}

export async function challenge(purpose: ChallengePurpose): Promise<string> {
  const { status, json } = await api('/auth/challenge', { body: { purpose } });
  if (status !== 200) throw new Error(`challenge failed: ${status}`);
  return json.nonce;
}

/** Insert an invite directly (bootstrap invites have no creator). */
export async function seedInvite(
  code: string,
  opts: { createdBy?: string | null; expiresAt?: number; maxUses?: number } = {},
) {
  const id = `inv_${code}`;
  await env.DB.prepare(
    'INSERT INTO invites (id, code_hash, created_by, max_uses, use_count, expires_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
  )
    .bind(
      id,
      await sha256Hex(code),
      opts.createdBy ?? null,
      opts.maxUses ?? 1,
      opts.expiresAt ?? Date.now() + 86_400_000,
      Date.now(),
    )
    .run();
  return id;
}

export const RECOVERY_KEY = 'P4Y98RJRK0XWTX0YKB7TV8DC';

export async function registerUser(
  overrides: {
    inviteCode?: string;
    username?: string;
    displayName?: string;
    recoveryKey?: string;
    device?: TestDevice;
  } = {},
) {
  const device = overrides.device ?? (await newDevice());
  const inviteCode = overrides.inviteCode ?? 'K7QM4XRT9PWD';
  if (!overrides.inviteCode) await seedInvite(inviteCode);
  const nonce = await challenge('register');
  const res = await api('/auth/register', {
    body: {
      inviteCode,
      username: overrides.username ?? 'maya',
      displayName: overrides.displayName ?? 'Maya Chen',
      recoveryKey: overrides.recoveryKey ?? RECOVERY_KEY,
      device: { name: 'iPhone', platform: 'ios', signingPublicKey: device.publicKey },
      nonce,
      signature: await device.sign(authSigningMessage('register', nonce, device.publicKey)),
    },
  });
  return { ...res, session: res.json as AuthSession, device };
}

export async function login(deviceId: string, device: TestDevice) {
  const nonce = await challenge('login');
  return api('/auth/login', {
    body: {
      deviceId,
      nonce,
      signature: await device.sign(authSigningMessage('login', nonce, deviceId)),
    },
  });
}

/** Two signed-up users (Maya invited by bootstrap, Dan invited by Maya). */
export async function twoUsers() {
  const maya = await registerUser();
  const invite = await api('/invites', { body: {}, token: maya.session.accessToken });
  const dan = await registerUser({
    inviteCode: invite.json.code,
    username: 'dan',
    displayName: 'Dan Okafor',
  });
  return { maya: maya.session, dan: dan.session, mayaDevice: maya.device, danDevice: dan.device };
}

export function uuid() {
  return crypto.randomUUID();
}

/** Open an authenticated realtime socket and collect its events. */
export async function openSocket(token?: string) {
  const res = await SELF.fetch('https://api.test/v1/realtime', {
    headers: { upgrade: 'websocket', ...(token && { authorization: `Bearer ${token}` }) },
  });
  const ws = res.webSocket;
  if (!ws)
    return {
      status: res.status,
      ws: null,
      events: [],
      next: async () => null,
      closed: () => null,
    } as const;
  ws.accept();
  const events: { type: string; [k: string]: unknown }[] = [];
  const waiters: (() => void)[] = [];
  let closed: { code: number } | null = null;
  ws.addEventListener('message', (e) => {
    events.push(JSON.parse(e.data as string));
    waiters.splice(0).forEach((w) => w());
  });
  ws.addEventListener('close', (e) => {
    closed = { code: e.code };
    waiters.splice(0).forEach((w) => w());
  });
  /** Wait for the first not-yet-consumed event of `type`. */
  const next = async (type: string, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = events.findIndex((e) => e.type === type);
      if (i >= 0) return events.splice(i, 1)[0]!;
      if (Date.now() > deadline) return null;
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  return { status: res.status, ws, events, next, closed: () => closed } as const;
}
