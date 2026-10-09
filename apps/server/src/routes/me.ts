import type { OkResponse } from '@koode/shared';
import { RotateRecoveryKeyRequest, UpdateProfileRequest, type User } from '@koode/shared';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/middleware';
import { toUser, type UserRow } from '../auth/sessions';
import { auditStatement } from '../lib/audit';
import { sha256Hex } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import { parseJson } from '../lib/validate';

const USER_COLUMNS = 'id, username, display_name, about, status, created_at';

async function loadUser(db: D1Database, id: string): Promise<UserRow> {
  const row = await db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`)
    .bind(id)
    .first<UserRow>();
  if (!row) throw new ApiError('not_found', 'Account not found');
  return row;
}

export const me = new Hono<AppEnv>()
  .use(requireAuth)
  .get('/', async (c) => c.json<User>(toUser(await loadUser(c.env.DB, c.get('auth').userId))))

  .patch('/', async (c) => {
    const patch = await parseJson(c, UpdateProfileRequest);
    const { userId, deviceId } = c.get('auth');
    const db = c.env.DB;
    await db.batch([
      db
        .prepare(
          `UPDATE users SET display_name = COALESCE(?, display_name), about = COALESCE(?, about), updated_at = ? WHERE id = ?`,
        )
        .bind(patch.displayName ?? null, patch.about ?? null, Date.now(), userId),
      auditStatement(db, 'profile_updated', { userId, deviceId }),
    ]);
    return c.json<User>(toUser(await loadUser(db, userId)));
  })

  .put('/recovery-key', async (c) => {
    const { recoveryKey } = await parseJson(c, RotateRecoveryKeyRequest);
    const { userId, deviceId } = c.get('auth');
    const db = c.env.DB;
    await db.batch([
      db
        .prepare('UPDATE users SET recovery_key_hash = ?, updated_at = ? WHERE id = ?')
        .bind(await sha256Hex(recoveryKey), Date.now(), userId),
      auditStatement(db, 'recovery_key_rotated', { userId, deviceId }),
    ]);
    return c.json<OkResponse>({ ok: true });
  });
