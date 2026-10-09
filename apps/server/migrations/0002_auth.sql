-- Migration 0002: authentication support.

ALTER TABLE users ADD COLUMN about TEXT NOT NULL DEFAULT '';

-- Single-use challenges for device-key signatures (register, login, recover).
-- A challenge is consumed atomically (UPDATE ... WHERE used_at IS NULL), so a
-- captured signature cannot be replayed.
CREATE TABLE auth_challenges (
  nonce       TEXT PRIMARY KEY,
  purpose     TEXT NOT NULL CHECK (purpose IN ('register', 'login', 'recover')),
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE INDEX auth_challenges_expires_at ON auth_challenges (expires_at);

-- Fixed-window rate-limit counters. `key` = "<rule>:<hashed client identifier>";
-- raw IP addresses are never stored.
CREATE TABLE rate_limits (
  key           TEXT PRIMARY KEY,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL
);

CREATE INDEX sessions_device_id_revoked_at ON sessions (device_id, revoked_at);
