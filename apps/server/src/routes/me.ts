import type { AvatarUploadResponse, OkResponse } from '@koode/shared';
import {
  AVATAR_LIMIT,
  DeleteAccountRequest,
  RotateRecoveryKeyRequest,
  UpdateProfileRequest,
  type User,
} from '@koode/shared';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/middleware';
import { toUser, type UserRow } from '../auth/sessions';
import { auditStatement } from '../lib/audit';
import { newId, sha256Hex } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import { parseJson } from '../lib/validate';
import { publishPresence } from '../presence';
import { avatarKey } from '../media/storage';
import { store } from './attachments';

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
          `UPDATE users SET display_name = COALESCE(?, display_name), about = COALESCE(?, about),
             last_seen_visibility = COALESCE(?, last_seen_visibility), updated_at = ? WHERE id = ?`,
        )
        .bind(
          patch.displayName ?? null,
          patch.about ?? null,
          patch.lastSeen ?? null,
          Date.now(),
          userId,
        ),
      auditStatement(db, 'profile_updated', { userId, deviceId }),
    ]);
    // Show or hide my presence for the people I chat with right away.
    if (patch.lastSeen)
      c.executionCtx.waitUntil(publishPresence(c.env, userId, patch.lastSeen === 'nobody'));
    return c.json<User>(toUser(await loadUser(db, userId)));
  })

  /**
   * My profile photo, encrypted on the device (the server can't tell what the
   * bytes are). A new upload replaces the old photo; its key reaches others
   * inside my messages.
   */
  .put('/avatar', async (c) => {
    if (c.req.header('content-type') !== 'application/octet-stream')
      throw new ApiError('bad_request', 'Profile photos must be encrypted');
    const { userId, deviceId } = c.get('auth');
    const db = c.env.DB;
    const avatarId = newId('av');
    await store(c, avatarKey(userId, avatarId), {
      max: AVATAR_LIMIT,
      contentType: 'application/octet-stream',
    });
    const previous = await db
      .prepare('SELECT avatar_key FROM users WHERE id = ?')
      .bind(userId)
      .first<{ avatar_key: string | null }>();
    await db.batch([
      db
        .prepare('UPDATE users SET avatar_key = ?, updated_at = ? WHERE id = ?')
        .bind(avatarId, Date.now(), userId),
      auditStatement(db, 'avatar_updated', { userId, deviceId }),
    ]);
    if (previous?.avatar_key) await c.env.MEDIA.delete(avatarKey(userId, previous.avatar_key));
    return c.json<AvatarUploadResponse>({ avatarId });
  })

  .delete('/avatar', async (c) => {
    const { userId, deviceId } = c.get('auth');
    const db = c.env.DB;
    const previous = await db
      .prepare('SELECT avatar_key FROM users WHERE id = ?')
      .bind(userId)
      .first<{ avatar_key: string | null }>();
    await db.batch([
      db
        .prepare('UPDATE users SET avatar_key = NULL, updated_at = ? WHERE id = ?')
        .bind(Date.now(), userId),
      auditStatement(db, 'avatar_updated', { userId, deviceId }),
    ]);
    if (previous?.avatar_key) await c.env.MEDIA.delete(avatarKey(userId, previous.avatar_key));
    return c.json<OkResponse>({ ok: true });
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
  })
  /**
   * Delete my account. The profile is scrubbed and disabled (rows that others
   * still reference, like calls, keep pointing at "Deleted account"); every
   * device, session, key, push registration and unused invite goes; in each
   * conversation my messages are deleted for everyone and I leave.
   */
  .delete('/', async (c) => {
    await parseJson(c, DeleteAccountRequest);
    const { userId, deviceId } = c.get('auth');
    const db = c.env.DB;
    const now = Date.now();
    // Audit first, while the account still exists (never any content).
    await auditStatement(db, 'account_deleted', { userId, deviceId }).run();

    const { results } = await db
      .prepare(
        `SELECT conversation_id FROM conversation_members WHERE user_id = ?1
         UNION SELECT DISTINCT conversation_id FROM messages WHERE sender_id = ?1`,
      )
      .bind(userId)
      .all<{ conversation_id: string }>();
    for (const { conversation_id } of results) {
      const room = c.env.CONVERSATION_ROOM.get(c.env.CONVERSATION_ROOM.idFromName(conversation_id));
      await room.eraseAccount({ conversationId: conversation_id, userId });
    }

    const photo = await db
      .prepare('SELECT avatar_key FROM users WHERE id = ?')
      .bind(userId)
      .first<{ avatar_key: string | null }>();
    if (photo?.avatar_key) await c.env.MEDIA.delete(avatarKey(userId, photo.avatar_key));

    const devices = 'SELECT id FROM devices WHERE user_id = ?1';
    await db.batch([
      db
        .prepare(
          `UPDATE users SET status = 'disabled', username = 'deleted-' || id, display_name = 'Deleted account',
             about = '', avatar_key = NULL, recovery_key_hash = NULL, updated_at = ?2 WHERE id = ?1`,
        )
        .bind(userId, now),
      db
        .prepare(
          `UPDATE sessions SET revoked_at = ?2 WHERE revoked_at IS NULL AND device_id IN (${devices})`,
        )
        .bind(userId, now),
      db
        .prepare('UPDATE devices SET revoked_at = COALESCE(revoked_at, ?2) WHERE user_id = ?1')
        .bind(userId, now),
      db.prepare(`DELETE FROM signal_prekeys WHERE device_id IN (${devices})`).bind(userId),
      db.prepare(`DELETE FROM signal_kyber_prekeys WHERE device_id IN (${devices})`).bind(userId),
      db.prepare('DELETE FROM signal_keys WHERE user_id = ?').bind(userId),
      db.prepare('DELETE FROM push_registrations WHERE user_id = ?').bind(userId),
      db.prepare('DELETE FROM message_envelopes WHERE user_id = ?').bind(userId),
      db.prepare('DELETE FROM call_envelopes WHERE user_id = ?').bind(userId),
      db.prepare('DELETE FROM invites WHERE created_by = ? AND use_count < max_uses').bind(userId),
    ]);
    // Close this account's live connections.
    const socket = c.env.USER_SOCKET.get(c.env.USER_SOCKET.idFromName(userId));
    const { results: owned } = await db
      .prepare('SELECT id FROM devices WHERE user_id = ?')
      .bind(userId)
      .all<{ id: string }>();
    c.executionCtx.waitUntil(Promise.allSettled(owned.map((d) => socket.disconnectDevice(d.id))));
    return c.json<OkResponse>({ ok: true });
  });
