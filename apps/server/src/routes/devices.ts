import type { OkResponse } from '@koode/shared';
import { RenameDeviceRequest, type Device } from '@koode/shared';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/middleware';
import { auditStatement } from '../lib/audit';
import { ApiError } from '../lib/errors';
import { parseJson } from '../lib/validate';

type DeviceRow = {
  id: string;
  name: string;
  platform: 'ios' | 'android';
  created_at: number;
  last_seen_at: number | null;
};

export const devices = new Hono<AppEnv>()
  .use(requireAuth)
  .get('/', async (c) => {
    const { userId, deviceId } = c.get('auth');
    const { results } = await c.env.DB.prepare(
      'SELECT id, name, platform, created_at, last_seen_at FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at',
    )
      .bind(userId)
      .all<DeviceRow>();
    return c.json<{ devices: Device[] }>({
      devices: results.map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform,
        createdAt: d.created_at,
        lastSeenAt: d.last_seen_at,
        current: d.id === deviceId,
      })),
    });
  })

  .patch('/:id', async (c) => {
    const { name } = await parseJson(c, RenameDeviceRequest);
    const { userId, deviceId } = c.get('auth');
    const db = c.env.DB;
    const target = c.req.param('id');
    // Scoped to the caller's own active devices: other users' ids look like 404s.
    const res = await db
      .prepare('UPDATE devices SET name = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
      .bind(name, target, userId)
      .run();
    if (res.meta.changes !== 1) throw new ApiError('not_found', 'Device not found');
    await auditStatement(db, 'device_renamed', { userId, deviceId }, { target }).run();
    return c.json<OkResponse>({ ok: true });
  })

  .delete('/:id', async (c) => {
    const { userId, deviceId } = c.get('auth');
    const db = c.env.DB;
    const target = c.req.param('id');
    const now = Date.now();
    const res = await db
      .prepare(
        'UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      )
      .bind(now, target, userId)
      .run();
    if (res.meta.changes !== 1) throw new ApiError('not_found', 'Device not found');
    await db.batch([
      db
        .prepare('UPDATE sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL')
        .bind(now, target),
      db.prepare('DELETE FROM push_registrations WHERE device_id = ?').bind(target),
      auditStatement(db, 'device_revoked', { userId, deviceId }, { target }),
    ]);
    c.executionCtx.waitUntil(
      c.env.USER_SOCKET.get(c.env.USER_SOCKET.idFromName(userId)).disconnectDevice(target),
    );
    return c.json<OkResponse>({ ok: true });
  });
