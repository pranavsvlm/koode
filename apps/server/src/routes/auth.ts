import type { ChallengeResponse, OkResponse } from '@koode/shared';
import {
  authSigningMessage,
  ChallengeRequest,
  LoginRequest,
  RecoverRequest,
  RefreshRequest,
  RegisterRequest,
  Username,
  type AuthSession,
  type TokenPair,
} from '@koode/shared';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/middleware';
import {
  authSessionResponse,
  consumeChallenge,
  issueChallenge,
  newSessionStatements,
  rotateRefreshToken,
  type UserRow,
} from '../auth/sessions';
import { auditStatement } from '../lib/audit';
import { newId, sha256Hex, timingSafeEqual, verifyEd25519 } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import { hit, rateLimit, RULES } from '../lib/rate-limit';
import { parseJson } from '../lib/validate';

const isUniqueViolation = (e: unknown) =>
  e instanceof Error && /UNIQUE constraint failed/i.test(e.message);

async function requireSignature(publicKey: string, message: string, signature: string) {
  if (!(await verifyEd25519(publicKey, message, signature))) {
    throw new ApiError('unauthorized', 'Signature verification failed');
  }
}

export const auth = new Hono<AppEnv>()
  .post('/challenge', rateLimit(RULES.challenge), async (c) => {
    const { purpose } = await parseJson(c, ChallengeRequest);
    return c.json<ChallengeResponse>(await issueChallenge(c.env.DB, purpose));
  })

  .get('/username/:username', rateLimit(RULES.usernameCheck), async (c) => {
    const parsed = Username.safeParse(c.req.param('username'));
    if (!parsed.success)
      return c.json({ available: false, reason: parsed.error.issues[0]?.message });
    const taken = await c.env.DB.prepare('SELECT 1 FROM users WHERE username = ?')
      .bind(parsed.data)
      .first();
    return c.json(
      taken ? { available: false, reason: 'This username is taken' } : { available: true },
    );
  })

  .post('/register', rateLimit(RULES.register), async (c) => {
    const body = await parseJson(c, RegisterRequest);
    const db = c.env.DB;
    const now = Date.now();

    await consumeChallenge(db, body.nonce, 'register');
    await requireSignature(
      body.device.signingPublicKey,
      authSigningMessage('register', body.nonce, body.device.signingPublicKey),
      body.signature,
    );

    const invite = await db
      .prepare(
        `SELECT id, created_by FROM invites
         WHERE code_hash = ? AND revoked_at IS NULL AND expires_at > ? AND use_count < max_uses`,
      )
      .bind(await sha256Hex(body.inviteCode), now)
      .first<{ id: string; created_by: string | null }>();
    if (!invite) throw new ApiError('forbidden', 'This invite is invalid, used up or expired');

    if (await db.prepare('SELECT 1 FROM users WHERE username = ?').bind(body.username).first()) {
      throw new ApiError('conflict', 'This username is taken');
    }

    // Claim one use of the invite; the guard makes concurrent claims safe.
    const claim = await db
      .prepare(
        `UPDATE invites SET use_count = use_count + 1
         WHERE id = ? AND use_count < max_uses AND revoked_at IS NULL AND expires_at > ?`,
      )
      .bind(invite.id, now)
      .run();
    if (claim.meta.changes !== 1)
      throw new ApiError('forbidden', 'This invite is invalid, used up or expired');

    const user: UserRow = {
      id: newId('usr'),
      username: body.username,
      display_name: body.displayName,
      about: '',
      status: 'active',
      created_at: now,
    };
    const deviceId = newId('dev');
    const session = await newSessionStatements(db, deviceId);
    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO users (id, username, display_name, about, role, status, invited_by, recovery_key_hash, created_at, updated_at)
             VALUES (?, ?, ?, '', ?, 'active', ?, ?, ?, ?)`,
          )
          .bind(
            user.id,
            user.username,
            user.display_name,
            // The first account (bootstrap invite) administers the instance.
            invite.created_by ? 'member' : 'admin',
            invite.created_by,
            await sha256Hex(body.recoveryKey),
            now,
            now,
          ),
        db
          .prepare(
            `INSERT INTO devices (id, user_id, name, platform, signing_public_key, created_at, last_seen_at, signal_device_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, (SELECT COALESCE(MAX(signal_device_id), 0) + 1 FROM devices WHERE user_id = ?2))`,
          )
          .bind(
            deviceId,
            user.id,
            body.device.name,
            body.device.platform,
            body.device.signingPublicKey,
            now,
            now,
          ),
        ...session.statements,
        auditStatement(
          db,
          'account_registered',
          { userId: user.id, deviceId },
          { viaInvite: invite.id },
        ),
      ]);
    } catch (e) {
      // Give the invite use back if the account couldn't be created.
      await db
        .prepare('UPDATE invites SET use_count = use_count - 1 WHERE id = ? AND use_count > 0')
        .bind(invite.id)
        .run();
      if (isUniqueViolation(e))
        throw new ApiError('conflict', 'This username or device is already registered');
      throw e;
    }

    return c.json<AuthSession>(
      await authSessionResponse(c.env, user, deviceId, session.sessionId, session.refreshToken),
      201,
    );
  })

  .post('/login', rateLimit(RULES.login), async (c) => {
    const body = await parseJson(c, LoginRequest);
    const db = c.env.DB;
    await consumeChallenge(db, body.nonce, 'login');

    const row = await db
      .prepare(
        `SELECT d.id AS device_id, d.signing_public_key, d.revoked_at, u.id, u.username, u.display_name, u.about, u.status, u.created_at
         FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = ?`,
      )
      .bind(body.deviceId)
      .first<
        UserRow & { device_id: string; signing_public_key: string; revoked_at: number | null }
      >();
    // Same error for unknown, revoked and suspended devices.
    if (!row || row.revoked_at || row.status !== 'active')
      throw new ApiError('unauthorized', 'Device is not signed in');
    await requireSignature(
      row.signing_public_key,
      authSigningMessage('login', body.nonce, body.deviceId),
      body.signature,
    );

    const session = await newSessionStatements(db, row.device_id);
    await db.batch([
      ...session.statements,
      db
        .prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?')
        .bind(Date.now(), row.device_id),
      auditStatement(db, 'login', { userId: row.id, deviceId: row.device_id }),
    ]);
    return c.json<AuthSession>(
      await authSessionResponse(c.env, row, row.device_id, session.sessionId, session.refreshToken),
    );
  })

  .post('/recover', rateLimit(RULES.recover), async (c) => {
    const body = await parseJson(c, RecoverRequest);
    const db = c.env.DB;
    if (!(await hit(c.env, RULES.recoverUser, body.username))) {
      throw new ApiError('rate_limited', 'Too many attempts for this account. Try again tomorrow.');
    }
    await consumeChallenge(db, body.nonce, 'recover');
    await requireSignature(
      body.device.signingPublicKey,
      authSigningMessage('recover', body.nonce, body.device.signingPublicKey),
      body.signature,
    );

    const user = await db
      .prepare(
        'SELECT id, username, display_name, about, status, created_at, recovery_key_hash FROM users WHERE username = ?',
      )
      .bind(body.username)
      .first<UserRow & { recovery_key_hash: string | null }>();
    const presented = await sha256Hex(body.recoveryKey);
    // Compare even when the user is missing, so timing doesn't reveal which usernames exist.
    const matches = timingSafeEqual(presented, user?.recovery_key_hash ?? '0'.repeat(64));
    if (!user || !matches || user.status !== 'active') {
      throw new ApiError('unauthorized', 'Username or recovery key is incorrect');
    }

    const now = Date.now();
    const deviceId = newId('dev');
    const session = await newSessionStatements(db, deviceId);
    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO devices (id, user_id, name, platform, signing_public_key, created_at, last_seen_at, signal_device_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, (SELECT COALESCE(MAX(signal_device_id), 0) + 1 FROM devices WHERE user_id = ?2))`,
          )
          .bind(
            deviceId,
            user.id,
            body.device.name,
            body.device.platform,
            body.device.signingPublicKey,
            now,
            now,
          ),
        ...session.statements,
        auditStatement(db, 'account_recovered', { userId: user.id, deviceId }),
      ]);
    } catch (e) {
      if (isUniqueViolation(e))
        throw new ApiError('conflict', 'This device key is already registered');
      throw e;
    }
    return c.json<AuthSession>(
      await authSessionResponse(c.env, user, deviceId, session.sessionId, session.refreshToken),
      201,
    );
  })

  .post('/refresh', rateLimit(RULES.refresh), async (c) => {
    const { refreshToken } = await parseJson(c, RefreshRequest);
    return c.json<TokenPair>(await rotateRefreshToken(c.env, refreshToken));
  })

  // Signing out removes this device: its key can no longer sign in. Getting
  // back in needs the recovery key (or, later, linking from another device).
  .post('/logout', requireAuth, async (c) => {
    const { userId, deviceId } = c.get('auth');
    const db = c.env.DB;
    const now = Date.now();
    await db.batch([
      db
        .prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .bind(now, deviceId),
      db
        .prepare('UPDATE sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL')
        .bind(now, deviceId),
      db.prepare('DELETE FROM push_registrations WHERE device_id = ?').bind(deviceId),
      auditStatement(db, 'logout', { userId, deviceId }),
    ]);
    c.executionCtx.waitUntil(
      c.env.USER_SOCKET.get(c.env.USER_SOCKET.idFromName(userId)).disconnectDevice(deviceId),
    );
    return c.json<OkResponse>({ ok: true });
  });
