-- Push registrations: one row per device that wants notifications.
-- Tokens are deleted when the device signs out or is removed, and when APNs/FCM
-- report them as no longer valid.
CREATE TABLE push_registrations (
  device_id        TEXT PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  platform         TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  app_id           TEXT NOT NULL,                       -- bundle id / package (APNs topic)
  environment      TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
  alert_token      TEXT UNIQUE,                         -- APNs device token or FCM token
  voip_token       TEXT UNIQUE,                         -- iOS PushKit token
  direct_messages  INTEGER NOT NULL DEFAULT 1,
  group_messages   INTEGER NOT NULL DEFAULT 1,
  calls            INTEGER NOT NULL DEFAULT 1,
  previews         INTEGER NOT NULL DEFAULT 1,           -- message text in notifications
  updated_at       INTEGER NOT NULL
);
CREATE INDEX push_registrations_user ON push_registrations (user_id);
