import { sign, verify } from 'hono/jwt';

export const ACCESS_TOKEN_TTL_MS = 15 * 60_000;
export const REFRESH_IDLE_TTL_MS = 30 * 24 * 60 * 60_000;
export const REFRESH_ABSOLUTE_TTL_MS = 180 * 24 * 60 * 60_000;
export const CHALLENGE_TTL_MS = 2 * 60_000;

const ISSUER = 'koode';
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
    env.AUTH_TOKEN_SECRET,
    ALG,
  );
  return { accessToken, accessTokenExpiresAt: exp };
}

/** Returns claims for a valid, unexpired token signed by us; otherwise null. */
export async function verifyAccessToken(env: Env, token: string): Promise<AccessClaims | null> {
  try {
    // The algorithm is pinned: tokens claiming any other `alg` are rejected.
    const payload = await verify(token, env.AUTH_TOKEN_SECRET, { alg: ALG, iss: ISSUER });
    const { sub, did, sid } = payload as Record<string, unknown>;
    if (typeof sub !== 'string' || typeof did !== 'string' || typeof sid !== 'string') return null;
    return { userId: sub, deviceId: did, sessionId: sid };
  } catch {
    return null;
  }
}
