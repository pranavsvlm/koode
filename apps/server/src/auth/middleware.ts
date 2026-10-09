import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../app';
import { ApiError } from '../lib/errors';
import { loadActiveSession } from './sessions';
import { verifyAccessToken } from './tokens';

const LAST_SEEN_RESOLUTION_MS = 5 * 60_000;

/**
 * Requires `Authorization: Bearer <access token>`. Besides the token
 * signature, the session, device and user are checked on every request, so
 * logout, device revocation and account suspension take effect immediately.
 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const claims = token ? await verifyAccessToken(c.env, token) : null;
  if (!claims) throw new ApiError('unauthorized', 'Sign in required');

  const session = await loadActiveSession(c.env.DB, claims.sessionId);
  if (!session || session.user_id !== claims.userId || session.device_id !== claims.deviceId) {
    throw new ApiError('unauthorized', 'Session expired');
  }
  c.set('auth', claims);

  const now = Date.now();
  const touch = c.env.DB.prepare(
    'UPDATE devices SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)',
  )
    .bind(now, claims.deviceId, now - LAST_SEEN_RESOLUTION_MS)
    .run();
  try {
    c.executionCtx.waitUntil(touch);
  } catch {
    await touch; // no ExecutionContext (e.g. some test harnesses)
  }

  await next();
};
