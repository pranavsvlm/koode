import { PushRegistration, type OkResponse } from '@koode/shared';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/middleware';
import { ApiError } from '../lib/errors';
import { parseJson } from '../lib/validate';

/** Push registration for the calling device (one per device; re-sent on token or setting changes). */
export const push = new Hono<AppEnv>()
  .use(requireAuth)

  .put('/', async (c) => {
    const reg = await parseJson(c, PushRegistration);
    const { userId, deviceId } = c.get('auth');
    const db = c.env.DB;
    const allowed = (c.env.PUSH_APP_IDS ?? '').split(',').map((s) => s.trim());
    if (!allowed.includes(reg.appId)) throw new ApiError('bad_request', 'Unknown app id');
    const device = await db
      .prepare('SELECT platform FROM devices WHERE id = ? AND revoked_at IS NULL')
      .bind(deviceId)
      .first<{ platform: string }>();
    if (!device || device.platform !== reg.platform)
      throw new ApiError('bad_request', 'Platform doesn’t match this device');

    const alertToken = reg.alertToken;
    const voipToken = reg.platform === 'ios' ? reg.voipToken : null;
    const environment = reg.platform === 'ios' ? reg.environment : 'production';
    const s = reg.settings;
    await db.batch([
      // A token belongs to one phone: drop it from any earlier device (e.g. a
      // previous account signed in on the same phone).
      db
        .prepare(
          `UPDATE push_registrations SET alert_token = CASE WHEN alert_token IN (?1, ?2) THEN NULL ELSE alert_token END,
             voip_token = CASE WHEN voip_token IN (?1, ?2) THEN NULL ELSE voip_token END
           WHERE device_id != ?3 AND (alert_token IN (?1, ?2) OR voip_token IN (?1, ?2))`,
        )
        .bind(alertToken ?? '', voipToken ?? '', deviceId),
      db
        .prepare(
          `INSERT INTO push_registrations (device_id, user_id, platform, app_id, environment, alert_token, voip_token,
             direct_messages, group_messages, calls, previews, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
           ON CONFLICT (device_id) DO UPDATE SET platform = ?3, app_id = ?4, environment = ?5,
             alert_token = ?6, voip_token = ?7, direct_messages = ?8, group_messages = ?9,
             calls = ?10, previews = ?11, updated_at = ?12`,
        )
        .bind(
          deviceId,
          userId,
          reg.platform,
          reg.appId,
          environment,
          alertToken,
          voipToken,
          s.directMessages ? 1 : 0,
          s.groupMessages ? 1 : 0,
          s.calls ? 1 : 0,
          s.previews ? 1 : 0,
          Date.now(),
        ),
    ]);
    return c.json<OkResponse>({ ok: true });
  })

  /** Stop all pushes to this device. */
  .delete('/', async (c) => {
    await c.env.DB.prepare('DELETE FROM push_registrations WHERE device_id = ?')
      .bind(c.get('auth').deviceId)
      .run();
    return c.json<OkResponse>({ ok: true });
  });
