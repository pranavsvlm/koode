import { sign, verify } from 'hono/jwt';

export const ACCESS_TOKEN_TTL_MS = 15 * 60_000;
export const REFRESH_IDLE_TTL_MS = 30 * 24 * 60 * 60_000;
export const REFRESH_ABSOLUTE_TTL_MS = 180 * 24 * 60 * 60_000;
export const CHALLENGE_TTL_MS = 2 * 60_000;

const ISSUER = 'koode';

/** Refuse to sign or verify with a missing or weak secret (misconfiguration guard). */
function signingSecret(env: Env): string {
  const secret = env.AUTH_TOKEN_SECRET;
  if (!secret || secret.length < 32)
    throw new Error('AUTH_TOKEN_SECRET is missing or shorter than 32 characters');
  return secret;
}
const ALG = 'HS256';

export type AccessClaims = { userId: string; deviceId: string; sessionId: string };

export async function issueAccessToken(
  env: Env,
  claims: AccessClaims,
  now = Date.now(),
): Promise<{ accessToken: string; accessTokenExpiresAt: number }> {
  const exp = now + ACCESS_TOKEN_TTL_MS;
  const accessToken = await sign(
    {
      iss: ISSUER,
      sub: claims.userId,
      did: claims.deviceId,
      sid: claims.sessionId,
      iat: Math.floor(now / 1000),
      exp: Math.floor(exp / 1000),
    },
    signingSecret(env),
    ALG,
  );
  return { accessToken, accessTokenExpiresAt: exp };
}

/** Returns claims for a valid, unexpired token signed by us; otherwise null. */
export async function verifyAccessToken(env: Env, token: string): Promise<AccessClaims | null> {
  try {
    // The algorithm is pinned: tokens claiming any other `alg` are rejected.
    const payload = await verify(token, signingSecret(env), { alg: ALG, iss: ISSUER });
    const { sub, did, sid } = payload as Record<string, unknown>;
    if (typeof sub !== 'string' || typeof did !== 'string' || typeof sid !== 'string') return null;
    return { userId: sub, deviceId: did, sessionId: sid };
  } catch {
    return null;
  }
}
