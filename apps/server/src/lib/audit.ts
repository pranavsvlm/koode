/**
 * Security audit trail. Record *what happened* to accounts and devices —
 * never message contents, tokens, keys or raw IP addresses.
 */
export type AuditEvent =
  | 'account_registered'
  | 'login'
  | 'account_recovered'
  | 'refresh_token_reuse'
  | 'device_renamed'
  | 'device_revoked'
  | 'logout'
  | 'recovery_key_rotated'
  | 'profile_updated'
  | 'invite_created'
  | 'invite_revoked'
  | 'keys_published'
  | 'identity_key_rejected'
  | 'message_deleted'
  | 'group_changed'
  | 'account_deleted';

export function auditStatement(
  db: D1Database,
  event: AuditEvent,
  ids: { userId?: string; deviceId?: string },
  metadata?: Record<string, string | number | boolean>,
): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO audit_events (event, user_id, device_id, metadata, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(
      event,
      ids.userId ?? null,
      ids.deviceId ?? null,
      metadata ? JSON.stringify(metadata) : null,
      Date.now(),
    );
}
