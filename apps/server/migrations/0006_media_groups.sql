-- Migration 0006: attachments, reactions, deletion, group system messages and
-- message revisions.
--
-- `messages` is rebuilt because SQLite can't change its `kind` CHECK. Every
-- change to a message (sent, reacted to, deleted) gives it the conversation's
-- next revision, so devices catch up on edits, not only new messages.

PRAGMA defer_foreign_keys = true;

CREATE TABLE messages_new (
  id                TEXT PRIMARY KEY,               -- client-generated UUID (idempotency key)
  conversation_id   TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,               -- order, assigned by the ConversationRoom DO
  rev               INTEGER NOT NULL,               -- last change, assigned by the DO
  sender_id         TEXT NOT NULL REFERENCES users (id),
  sender_device_id  TEXT,
  kind              TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'attachment', 'system')),
  encryption        TEXT NOT NULL DEFAULT 'none' CHECK (encryption IN ('none')),
  body              TEXT NOT NULL,                  -- text or caption; '' once deleted
  reply_to_id       TEXT,
  attachment_id     TEXT,
  system            TEXT,                           -- JSON SystemEvent for kind = 'system'
  deleted_at        INTEGER,                        -- deleted for everyone
  created_at        INTEGER NOT NULL,
  UNIQUE (conversation_id, seq)
);
INSERT INTO messages_new
  (id, conversation_id, seq, rev, sender_id, sender_device_id, kind, encryption, body, reply_to_id, created_at)
  SELECT id, conversation_id, seq, seq, sender_id, sender_device_id, kind, encryption, body, reply_to_id, created_at
  FROM messages;
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
CREATE INDEX messages_rev ON messages (conversation_id, rev);

ALTER TABLE conversations ADD COLUMN last_rev INTEGER NOT NULL DEFAULT 0;
UPDATE conversations SET last_rev = last_seq;

-- Files live in the private R2 bucket (key att/<conversation>/<attachment>);
-- this row holds the metadata and who may read them.
CREATE TABLE attachments (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  uploader_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  message_id       TEXT,                            -- set when sent; unsent ones expire
  kind             TEXT NOT NULL CHECK (kind IN ('image', 'video', 'document', 'voice')),
  mime_type        TEXT NOT NULL,
  size_bytes       INTEGER NOT NULL,
  name             TEXT,
  width            INTEGER,
  height           INTEGER,
  duration_ms      INTEGER,
  waveform         TEXT,                            -- JSON number[] (voice)
  preview          TEXT,                            -- tiny base64 JPEG placeholder
  has_thumbnail    INTEGER NOT NULL DEFAULT 0,      -- video poster stored next to it
  uploaded_at      INTEGER,                         -- content received and size checked
  created_at       INTEGER NOT NULL
);
CREATE INDEX attachments_unsent ON attachments (created_at) WHERE message_id IS NULL;
CREATE UNIQUE INDEX attachments_message ON attachments (message_id) WHERE message_id IS NOT NULL;

-- One reaction per person per message.
CREATE TABLE reactions (
  message_id  TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  emoji       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
