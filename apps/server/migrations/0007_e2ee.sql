-- Migration 0007: end-to-end encryption (libsignal).
--
-- The server becomes a public-key directory and a ciphertext mailbox. Message
-- content, reactions and attachment metadata move into per-device envelopes;
-- `messages` keeps only routing and ordering. Plaintext rows from before this
-- migration stay readable as they are (encryption = 'none').

PRAGMA defer_foreign_keys = true;

-- ——— Devices: a small Signal device number per account (1, 2, 3 …) ———

ALTER TABLE devices ADD COLUMN signal_device_id INTEGER;
UPDATE devices SET signal_device_id = (
  SELECT COUNT(*) FROM devices d2
  WHERE d2.user_id = devices.user_id
    AND (d2.created_at < devices.created_at OR (d2.created_at = devices.created_at AND d2.id <= devices.id))
);
CREATE UNIQUE INDEX devices_signal_id ON devices (user_id, signal_device_id);

-- ——— Key directory (public keys only) ———

CREATE TABLE signal_keys (
  device_id         TEXT PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  registration_id   INTEGER NOT NULL,
  identity_key      TEXT NOT NULL,                  -- fixed for the device's lifetime
  signed_prekey     TEXT NOT NULL,                  -- JSON {keyId, publicKey, signature}
  kyber_prekey      TEXT NOT NULL,                  -- JSON, last-resort key
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX signal_keys_user ON signal_keys (user_id);

-- One-time keys: each is handed out once, then deleted.
CREATE TABLE signal_prekeys (
  device_id   TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  key_id      INTEGER NOT NULL,
  public_key  TEXT NOT NULL,
  PRIMARY KEY (device_id, key_id)
);
CREATE TABLE signal_kyber_prekeys (
  device_id   TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  key_id      INTEGER NOT NULL,
  public_key  TEXT NOT NULL,
  signature   TEXT NOT NULL,
  PRIMARY KEY (device_id, key_id)
);

-- ——— Messages: rebuilt for the new kinds and encryption ———

CREATE TABLE messages_new (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  rev               INTEGER NOT NULL,
  sender_id         TEXT NOT NULL REFERENCES users (id),
  sender_device_id  TEXT,                           -- devices.id
  sender_device     INTEGER,                        -- Signal device number (decryption address)
  kind              TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'attachment', 'system', 'reaction')),
  encryption        TEXT NOT NULL DEFAULT 'none' CHECK (encryption IN ('none', 'signal')),
  body              TEXT NOT NULL,                  -- plaintext rows only; '' when encrypted or deleted
  reply_to_id       TEXT,                           -- plaintext rows only (encrypted: in the envelope)
  attachment_id     TEXT,
  target_id         TEXT,                           -- kind = 'reaction'
  system            TEXT,
  deleted_at        INTEGER,
  created_at        INTEGER NOT NULL,
  UNIQUE (conversation_id, seq)
);
INSERT INTO messages_new
  (id, conversation_id, seq, rev, sender_id, sender_device_id, kind, encryption, body, reply_to_id,
   attachment_id, system, deleted_at, created_at)
  SELECT id, conversation_id, seq, rev, sender_id, sender_device_id, kind, encryption, body, reply_to_id,
   attachment_id, system, deleted_at, created_at
  FROM messages;
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
CREATE INDEX messages_rev ON messages (conversation_id, rev);
CREATE INDEX messages_target ON messages (target_id) WHERE target_id IS NOT NULL;

-- One ciphertext per recipient device. Kept with the message (the Double
-- Ratchet deletes its keys on the device, so stored ciphertext can't be
-- decrypted again); erased when the message is deleted for everyone.
CREATE TABLE message_envelopes (
  message_id  TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  device      INTEGER NOT NULL,                     -- recipient's Signal device number
  type        INTEGER NOT NULL CHECK (type IN (2, 3)),
  body        TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, device)
);
CREATE INDEX message_envelopes_user ON message_envelopes (user_id, message_id);

-- Reactions are now encrypted messages (kind = 'reaction'); the plaintext table goes.
DROP TABLE reactions;

-- ——— Attachments: content is ciphertext ———

CREATE TABLE attachments_new (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  uploader_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  message_id       TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('image', 'video', 'document', 'voice', 'encrypted')),
  mime_type        TEXT NOT NULL,
  size_bytes       INTEGER NOT NULL,
  name             TEXT,
  width            INTEGER,
  height           INTEGER,
  duration_ms      INTEGER,
  waveform         TEXT,
  preview          TEXT,
  has_thumbnail    INTEGER NOT NULL DEFAULT 0,
  uploaded_at      INTEGER,
  created_at       INTEGER NOT NULL
);
INSERT INTO attachments_new SELECT id, conversation_id, uploader_id, message_id, kind, mime_type,
  size_bytes, name, width, height, duration_ms, waveform, preview, has_thumbnail, uploaded_at, created_at
  FROM attachments;
DROP TABLE attachments;
ALTER TABLE attachments_new RENAME TO attachments;
CREATE INDEX attachments_unsent ON attachments (created_at) WHERE message_id IS NULL;
CREATE UNIQUE INDEX attachments_message ON attachments (message_id) WHERE message_id IS NOT NULL;

-- ——— Calls: the media key, encrypted to each of the callee's devices ———

ALTER TABLE calls ADD COLUMN caller_device INTEGER;
CREATE TABLE call_envelopes (
  call_id  TEXT NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL,
  device   INTEGER NOT NULL,
  type     INTEGER NOT NULL CHECK (type IN (2, 3)),
  body     TEXT NOT NULL,
  PRIMARY KEY (call_id, user_id, device)
);
