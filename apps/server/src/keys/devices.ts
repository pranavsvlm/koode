import type { DeviceMismatch, OutgoingEnvelope } from '@koode/shared';

/** A device that can receive encrypted messages: active, with published keys. */
export type KeyedDevice = { userId: string; deviceId: number; identityKey: string };

export async function keyedDevices(db: D1Database, userIds: string[]): Promise<KeyedDevice[]> {
  if (userIds.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT d.user_id, d.signal_device_id, k.identity_key FROM devices d
       JOIN signal_keys k ON k.device_id = d.id
       JOIN users u ON u.id = d.user_id AND u.status = 'active'
       WHERE d.revoked_at IS NULL AND d.user_id IN (${userIds.map(() => '?').join(',')})
       ORDER BY d.user_id, d.signal_device_id`,
    )
    .bind(...userIds)
    .all<{ user_id: string; signal_device_id: number; identity_key: string }>();
  return results.map((r) => ({
    userId: r.user_id,
    deviceId: r.signal_device_id,
    identityKey: r.identity_key,
  }));
}

/** The requesting device's Signal number. */
export async function signalDeviceId(db: D1Database, deviceId: string): Promise<number> {
  const row = await db
    .prepare('SELECT signal_device_id FROM devices WHERE id = ?')
    .bind(deviceId)
    .first<{ signal_device_id: number | null }>();
  if (!row?.signal_device_id) throw new Error(`device ${deviceId} has no Signal number`);
  return row.signal_device_id;
}

const key = (d: { userId: string; deviceId: number }) => `${d.userId}.${d.deviceId}`;

/**
 * Envelopes must address exactly `expected`, once each. Returns null when
 * they do, otherwise what's missing and what shouldn't be there (unknown,
 * revoked or duplicate devices), so the sender can refresh and retry.
 */
export function coverage(
  expected: { userId: string; deviceId: number }[],
  envelopes: Pick<OutgoingEnvelope, 'userId' | 'deviceId'>[],
): DeviceMismatch | null {
  const want = new Set(expected.map(key));
  const seen = new Set<string>();
  const extra: DeviceMismatch['extra'] = [];
  for (const e of envelopes) {
    const k = key(e);
    if (!want.has(k) || seen.has(k)) extra.push({ userId: e.userId, deviceId: e.deviceId });
    seen.add(k);
  }
  const missing = expected
    .filter((d) => !seen.has(key(d)))
    .map((d) => ({ userId: d.userId, deviceId: d.deviceId }));
  return missing.length || extra.length ? { missing, extra } : null;
}
