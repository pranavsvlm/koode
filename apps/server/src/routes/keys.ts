import {
  MAX_ONE_TIME_KEYS,
  PublishKeysRequest,
  UploadOneTimeKeysRequest,
  type KeyDeviceList,
  type KeyStatus,
  type KyberPreKey,
  type OkResponse,
  type PreKeyBundle,
  type SignedPreKey,
} from '@koode/shared';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/middleware';
import { keyedDevices, signalDeviceId } from '../keys/devices';
import { auditStatement } from '../lib/audit';
import { ApiError } from '../lib/errors';
import { limitUser, RULES } from '../lib/rate-limit';
import { BODY_LIMITS, parseJson } from '../lib/validate';

type KeysRow = {
  device_id: string;
  user_id: string;
  signal_device_id: number;
  registration_id: number;
  identity_key: string;
  signed_prekey: string;
  kyber_prekey: string;
};

async function counts(db: D1Database, deviceId: string) {
  const [pre, kyber] = await db.batch<{ n: number }>([
    db.prepare('SELECT COUNT(*) AS n FROM signal_prekeys WHERE device_id = ?').bind(deviceId),
    db.prepare('SELECT COUNT(*) AS n FROM signal_kyber_prekeys WHERE device_id = ?').bind(deviceId),
  ]);
  return { preKeys: pre!.results[0]?.n ?? 0, kyberPreKeys: kyber!.results[0]?.n ?? 0 };
}

/** Statements adding one-time keys, refusing to exceed the per-device cap. */
async function oneTimeKeyStatements(
  db: D1Database,
  deviceId: string,
  keys: { preKeys: { keyId: number; publicKey: string }[]; kyberPreKeys: KyberPreKey[] },
): Promise<D1PreparedStatement[]> {
  const have = await counts(db, deviceId);
  if (
    have.preKeys + keys.preKeys.length > MAX_ONE_TIME_KEYS ||
    have.kyberPreKeys + keys.kyberPreKeys.length > MAX_ONE_TIME_KEYS
  )
    throw new ApiError('bad_request', `A device may hold at most ${MAX_ONE_TIME_KEYS} of each key`);
  return [
    ...keys.preKeys.map((k) =>
      db
        .prepare(
          'INSERT OR REPLACE INTO signal_prekeys (device_id, key_id, public_key) VALUES (?, ?, ?)',
        )
        .bind(deviceId, k.keyId, k.publicKey),
    ),
    ...keys.kyberPreKeys.map((k) =>
      db
        .prepare(
          'INSERT OR REPLACE INTO signal_kyber_prekeys (device_id, key_id, public_key, signature) VALUES (?, ?, ?, ?)',
        )
        .bind(deviceId, k.keyId, k.publicKey, k.signature),
    ),
  ];
}

/** Bundles for a person's devices, each taking (and deleting) one one-time key of each kind. */
async function bundles(db: D1Database, userId: string, only?: number): Promise<PreKeyBundle[]> {
  const { results } = await db
    .prepare(
      `SELECT k.*, d.signal_device_id FROM signal_keys k
       JOIN devices d ON d.id = k.device_id AND d.revoked_at IS NULL
       JOIN users u ON u.id = k.user_id AND u.status = 'active'
       WHERE k.user_id = ? ${only !== undefined ? 'AND d.signal_device_id = ?' : ''}
       ORDER BY d.signal_device_id`,
    )
    .bind(...(only !== undefined ? [userId, only] : [userId]))
    .all<KeysRow>();
  return Promise.all(
    results.map(async (r) => {
      const [pre, kyber] = await db.batch<Record<string, unknown>>([
        db
          .prepare(
            `DELETE FROM signal_prekeys WHERE device_id = ?1 AND key_id =
               (SELECT key_id FROM signal_prekeys WHERE device_id = ?1 ORDER BY key_id LIMIT 1)
             RETURNING key_id, public_key`,
          )
          .bind(r.device_id),
        db
          .prepare(
            `DELETE FROM signal_kyber_prekeys WHERE device_id = ?1 AND key_id =
               (SELECT key_id FROM signal_kyber_prekeys WHERE device_id = ?1 ORDER BY key_id LIMIT 1)
             RETURNING key_id, public_key, signature`,
          )
          .bind(r.device_id),
      ]);
      const p = pre!.results[0] as { key_id: number; public_key: string } | undefined;
      const k = kyber!.results[0] as
        { key_id: number; public_key: string; signature: string } | undefined;
      return {
        userId: r.user_id,
        deviceId: r.signal_device_id,
        registrationId: r.registration_id,
        identityKey: r.identity_key,
        signedPreKey: JSON.parse(r.signed_prekey) as SignedPreKey,
        // A one-time Kyber key when there is one, else the last-resort key.
        kyberPreKey: k
          ? { keyId: k.key_id, publicKey: k.public_key, signature: k.signature }
          : (JSON.parse(r.kyber_prekey) as KyberPreKey),
        preKey: p ? { keyId: p.key_id, publicKey: p.public_key } : null,
      };
    }),
  );
}

const MAX_LOOKUP_USERS = 64;

export const keys = new Hono<AppEnv>()
  .use(requireAuth)

  /** Publish (or refresh) this device's keys. The identity key can never change. */
  .put('/', async (c) => {
    const req = await parseJson(c, PublishKeysRequest, BODY_LIMITS.keys);
    const { userId, deviceId } = c.get('auth');
    const db = c.env.DB;
    const existing = await db
      .prepare('SELECT identity_key, registration_id FROM signal_keys WHERE device_id = ?')
      .bind(deviceId)
      .first<{ identity_key: string; registration_id: number }>();
    if (
      existing &&
      (existing.identity_key !== req.identityKey || existing.registration_id !== req.registrationId)
    ) {
      await auditStatement(db, 'identity_key_rejected', { userId, deviceId }).run();
      throw new ApiError(
        'conflict',
        'This device already has a different identity. Sign out and in again to start over.',
      );
    }
    const now = Date.now();
    await db.batch([
      db
        .prepare(
          `INSERT INTO signal_keys (device_id, user_id, registration_id, identity_key, signed_prekey, kyber_prekey, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
           ON CONFLICT (device_id) DO UPDATE SET signed_prekey = excluded.signed_prekey,
             kyber_prekey = excluded.kyber_prekey, updated_at = excluded.updated_at`,
        )
        .bind(
          deviceId,
          userId,
          req.registrationId,
          req.identityKey,
          JSON.stringify(req.signedPreKey),
          JSON.stringify(req.kyberPreKey),
          now,
        ),
      ...(await oneTimeKeyStatements(db, deviceId, req)),
      ...(existing ? [] : [auditStatement(db, 'keys_published', { userId, deviceId })]),
    ]);
    return c.json<OkResponse>({ ok: true });
  })

  .post('/one-time', async (c) => {
    const req = await parseJson(c, UploadOneTimeKeysRequest, BODY_LIMITS.keys);
    const { deviceId } = c.get('auth');
    const db = c.env.DB;
    const published = await db
      .prepare('SELECT 1 FROM signal_keys WHERE device_id = ?')
      .bind(deviceId)
      .first();
    if (!published) throw new ApiError('bad_request', 'Publish this device’s keys first');
    const statements = await oneTimeKeyStatements(db, deviceId, req);
    if (statements.length) await db.batch(statements);
    return c.json<OkResponse>({ ok: true });
  })

  .get('/status', async (c) => {
    const { deviceId } = c.get('auth');
    const db = c.env.DB;
    const row = await db
      .prepare('SELECT identity_key FROM signal_keys WHERE device_id = ?')
      .bind(deviceId)
      .first<{ identity_key: string }>();
    return c.json<KeyStatus>({
      deviceId: await signalDeviceId(db, deviceId),
      published: !!row,
      identityKey: row?.identity_key ?? null,
      ...(await counts(db, deviceId)),
    });
  })

  /** Devices (with identity keys) of up to 64 people: `?userIds=a,b`. Doesn't use up keys. */
  .get('/devices', async (c) => {
    const ids = [...new Set((c.req.query('userIds') ?? '').split(',').filter(Boolean))];
    if (ids.length === 0 || ids.length > MAX_LOOKUP_USERS || ids.some((i) => i.length > 64))
      throw new ApiError('bad_request', `Ask for 1–${MAX_LOOKUP_USERS} people`);
    return c.json<KeyDeviceList>({ devices: await keyedDevices(c.env.DB, ids) });
  })

  /**
   * Bundles to start sessions with someone's devices (all, or `/:deviceId`).
   * Each hands out one-time keys, so it's rate limited per requester.
   */
  .get('/:userId/:deviceId?', async (c) => {
    await limitUser(c.env, RULES.keyBundles, c.get('auth').userId);
    const raw = c.req.param('deviceId');
    const only = raw === undefined ? undefined : Number(raw);
    if (only !== undefined && (!Number.isInteger(only) || only < 1 || only > 127))
      throw new ApiError('bad_request', 'Invalid device');
    const list = await bundles(c.env.DB, c.req.param('userId'), only);
    if (list.length === 0) throw new ApiError('not_found', 'No devices with keys');
    return c.json<{ bundles: PreKeyBundle[] }>({ bundles: list });
  });
