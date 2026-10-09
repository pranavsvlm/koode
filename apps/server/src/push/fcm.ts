import { importPKCS8, SignJWT } from 'jose';
import type { PushResult } from './apns';

/**
 * Firebase Cloud Messaging (HTTP v1), called directly from the Worker.
 * Authenticates with a Google service account (OAuth 2.0 JWT bearer grant,
 * RS256 via `jose`). The service account JSON is the `FCM_SERVICE_ACCOUNT` secret.
 */

type ServiceAccount = { project_id: string; client_email: string; private_key: string };

/** Android message: data-only so expo-notifications renders it with our channels. */
export type FcmMessage = {
  token: string;
  data: Record<string, string>;
  /** Calls: deliver immediately or not at all. */
  ttlSeconds: number;
};

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

let cached: { key: string; token: string; expiresAt: number } | null = null;

function account(env: Env): ServiceAccount | null {
  if (!env.FCM_SERVICE_ACCOUNT) return null;
  try {
    const a = JSON.parse(env.FCM_SERVICE_ACCOUNT) as ServiceAccount;
    return a.project_id && a.client_email && a.private_key ? a : null;
  } catch {
    return null;
  }
}

export const fcmConfigured = (env: Env) => account(env) !== null;

async function accessToken(a: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.key === a.client_email && cached.expiresAt > now + 60) return cached.token;
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(a.client_email)
    .setAudience(TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(await importPKCS8(a.private_key, 'RS256'));
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`FCM auth failed (${res.status})`);
  const body = await res.json<{ access_token: string; expires_in: number }>();
  cached = { key: a.client_email, token: body.access_token, expiresAt: now + body.expires_in };
  return body.access_token;
}

export async function sendFcm(env: Env, message: FcmMessage): Promise<PushResult> {
  const a = account(env);
  if (!a) return { ok: false, unregistered: false, reason: 'not-configured' };
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(a.project_id)}/messages:send`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await accessToken(a)}`,
      },
      body: JSON.stringify({
        message: {
          token: message.token,
          data: message.data,
          android: { priority: 'high', ttl: `${message.ttlSeconds}s` },
        },
      }),
    },
  );
  if (res.ok) return { ok: true };
  const body = await res
    .json<{ error?: { status?: string; details?: { errorCode?: string }[] } }>()
    .catch(() => ({}) as { error?: undefined });
  const code = body.error?.details?.find((d) => d.errorCode)?.errorCode ?? body.error?.status;
  return {
    ok: false,
    // App uninstalled or token rotated. (Not INVALID_ARGUMENT: that can be our payload.)
    unregistered: code === 'UNREGISTERED' || res.status === 404,
    reason: code ?? `http-${res.status}`,
  };
}

/** Test hook: forget the cached OAuth token. */
export function resetFcmAuthCache() {
  cached = null;
}
