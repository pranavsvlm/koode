import type { AuthSession, ChallengePurpose, TokenPair, User } from '@koode/shared';
import { auditStatement } from '../lib/audit';
import { newId, randomToken, sha256Hex } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import {
  CHALLENGE_TTL_MS,
  issueAccessToken,
  REFRESH_ABSOLUTE_TTL_MS,
  REFRESH_IDLE_TTL_MS,
} from './tokens';

export type UserRow = {
  id: string;
  username: string;
  display_name: string;
  about: string;
  status: 'active' | 'disabled';
  created_at: number;
};

export const toUser = (r: UserRow): User => ({
  id: r.id,
  username: r.username,
  displayName: r.display_name,
  about: r.about,
  createdAt: r.created_at,
});

export async function issueChallenge(db: D1Database, purpose: ChallengePurpose) {
  const now = Date.now();
  const nonce = randomToken(24);
  const expiresAt = now + CHALLENGE_TTL_MS;
  await db.batch([
    // Opportunistic cleanup keeps the table small without a cron job.
    db.prepare('DELETE FROM auth_challenges WHERE expires_at < ?').bind(now - 60 * 60_000),
    db
      .prepare('INSERT INTO auth_challenges (nonce, purpose, expires_at) VALUES (?, ?, ?)')
      .bind(nonce, purpose, expiresAt),
  ]);
  return { nonce, expiresAt };
}

/** Atomically marks a challenge used. Fails for unknown, expired, reused or wrong-purpose nonces. */
export async function consumeChallenge(
  db: D1Database,
  nonce: string,
  purpose: ChallengePurpose,
): Promise<void> {
  const now = Date.now();
  const res = await db
    .prepare(
      'UPDATE auth_challenges SET used_at = ? WHERE nonce = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?',
    )
    .bind(now, nonce, purpose, now)
    .run();
  if (res.meta.changes !== 1) throw new ApiError('unauthorized', 'Challenge is invalid or expired');
}

/**
 * Statements that start a fresh session for a device. A device holds at most
 * one live session: any previous session is revoked.
 */
export async function newSessionStatements(db: D1Database, deviceId: string) {
  const now = Date.now();
  const sessionId = newId('ses');
  const refreshToken = randomToken(32);
  const statements = [
    db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL')
      .bind(now, deviceId),
    db
      .prepare(
        'INSERT INTO sessions (id, device_id, refresh_token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(sessionId, deviceId, await sha256Hex(refreshToken), now, now + REFRESH_IDLE_TTL_MS),
  ];
  return { sessionId, refreshToken, statements };
}

export async function authSessionResponse(
  env: Env,
  user: UserRow,
  deviceId: string,
  sessionId: string,
  refreshToken: string,
): Promise<AuthSession> {
  const access = await issueAccessToken(env, { userId: user.id, deviceId, sessionId });
  return { user: toUser(user), deviceId, refreshToken, ...access };
}

type SessionLookup = {
  id: string;
  device_id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  device_revoked_at: number | null;
  user_status: string;
};

const SESSION_JOIN = `SELECT s.id, s.device_id, d.user_id, s.created_at, s.expires_at, s.revoked_at,
  d.revoked_at AS device_revoked_at, u.status AS user_status
  FROM sessions s JOIN devices d ON d.id = s.device_id JOIN users u ON u.id = d.user_id`;

/**
 * Rotate a refresh token. Presenting a token that was already rotated is
 * treated as theft: the whole session is revoked (the device can still sign
 * in again with its key).
 */
export async function rotateRefreshToken(env: Env, refreshToken: string): Promise<TokenPair> {
  const db = env.DB;
  const now = Date.now();
  const hash = await sha256Hex(refreshToken);
  const s = await db
    .prepare(`${SESSION_JOIN} WHERE s.refresh_token_hash = ?`)
    .bind(hash)
    .first<SessionLookup>();

  if (!s) {
    const reused = await db
      .prepare(`${SESSION_JOIN} WHERE s.previous_refresh_token_hash = ? AND s.revoked_at IS NULL`)
      .bind(hash)
      .first<SessionLookup>();
    if (reused) {
      await db.batch([
        db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').bind(now, reused.id),
        auditStatement(db, 'refresh_token_reuse', {
          userId: reused.user_id,
          deviceId: reused.device_id,
        }),
      ]);
    }
    throw new ApiError('unauthorized', 'Session expired');
  }
  if (s.revoked_at || s.device_revoked_at || s.user_status !== 'active' || s.expires_at <= now) {
    throw new ApiError('unauthorized', 'Session expired');
  }

  const next = randomToken(32);
  const expiresAt = Math.min(now + REFRESH_IDLE_TTL_MS, s.created_at + REFRESH_ABSOLUTE_TTL_MS);
  // Conditional on the old hash, so two concurrent refreshes can't both win.
  const res = await db
    .prepare(
      `UPDATE sessions SET refresh_token_hash = ?, previous_refresh_token_hash = ?, rotated_at = ?, expires_at = ?
       WHERE id = ? AND refresh_token_hash = ? AND revoked_at IS NULL`,
    )
    .bind(await sha256Hex(next), hash, now, expiresAt, s.id, hash)
    .run();
  if (res.meta.changes !== 1) throw new ApiError('unauthorized', 'Session expired');

  const access = await issueAccessToken(env, {
    userId: s.user_id,
    deviceId: s.device_id,
    sessionId: s.id,
  });
  return { ...access, refreshToken: next };
}

/** Live-session check used by the auth middleware on every request. */
export async function loadActiveSession(db: D1Database, sessionId: string) {
  const s = await db
    .prepare(`${SESSION_JOIN} WHERE s.id = ?`)
    .bind(sessionId)
    .first<SessionLookup>();
  if (!s || s.revoked_at || s.device_revoked_at || s.user_status !== 'active') return null;
  return s;
}
