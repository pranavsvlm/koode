/**
 * APNs through the push relay (apps/push-relay).
 *
 * APNs only speaks HTTP/2, and Worker subrequests don't negotiate it (verified
 * against local workerd: "Network connection lost"). The relay holds the APNs
 * signing key and forwards over HTTP/2; this Worker never sees the key.
 */

export type ApnsPush = {
  token: string;
  /** Bundle id; `.voip` is appended for PushKit pushes. */
  appId: string;
  environment: 'sandbox' | 'production';
  pushType: 'alert' | 'voip';
  /** APNs JSON payload (`aps` + custom keys). */
  payload: Record<string, unknown>;
  /** 10 = immediate, 5 = power-considerate. */
  priority: 10 | 5;
  /** Seconds since epoch after which APNs drops it; 0 = deliver now or never. */
  expiration: number;
  collapseId?: string;
};

export type PushResult =
  /** Delivered to APNs/FCM (not necessarily to the device). */
  | { ok: true }
  /** The token is dead: delete it. */
  | { ok: false; unregistered: true; reason: string }
  | { ok: false; unregistered: false; reason: string };

/** APNs reasons that mean the token will never work again. */
const DEAD_TOKEN = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

export function apnsConfigured(env: Env): boolean {
  return !!env.PUSH_RELAY_URL && (env.PUSH_RELAY_SECRET?.length ?? 0) >= 32;
}

export async function sendApns(env: Env, push: ApnsPush): Promise<PushResult> {
  if (!apnsConfigured(env)) return { ok: false, unregistered: false, reason: 'not-configured' };
  const res = await fetch(new URL('/apns', env.PUSH_RELAY_URL), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.PUSH_RELAY_SECRET}`,
    },
    body: JSON.stringify({
      ...push,
      topic: push.pushType === 'voip' ? `${push.appId}.voip` : push.appId,
    }),
  });
  type RelayResponse = { status?: number; reason?: string };
  const body = await res.json<RelayResponse>().catch((): RelayResponse => ({}));
  if (res.ok && body.status === 200) return { ok: true };
  const reason = body.reason ?? `relay-${res.status}`;
  return {
    ok: false,
    unregistered: body.status === 410 || DEAD_TOKEN.has(reason),
    reason,
  };
}
