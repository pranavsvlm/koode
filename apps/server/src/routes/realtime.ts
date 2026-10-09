import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/middleware';
import { ApiError } from '../lib/errors';

/**
 * WebSocket endpoint. Authenticated with the normal `Authorization: Bearer`
 * header on the upgrade request (React Native supports custom headers), so
 * tokens never appear in URLs or access logs.
 */
export const realtime = new Hono<AppEnv>().get('/', requireAuth, async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    throw new ApiError('bad_request', 'Expected a WebSocket upgrade');
  }
  const { userId, deviceId } = c.get('auth');
  const headers = new Headers(c.req.raw.headers);
  headers.delete('authorization');
  headers.set('x-koode-user-id', userId);
  headers.set('x-koode-device-id', deviceId);
  const stub = c.env.USER_SOCKET.get(c.env.USER_SOCKET.idFromName(userId));
  return stub.fetch(new Request(c.req.url, { headers }));
});
