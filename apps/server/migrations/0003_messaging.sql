-- Migration 0003: conversations and messages.
--
-- Message bodies are plaintext in this phase (protected by TLS only). The
-- `encryption` column exists so end-to-end encrypted envelopes (Phase 8) can
-- be introduced without rewriting history.

CREATE TABLE conversations (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
  title            TEXT,
  -- "<userA>:<userB>" (sorted) for direct chats, so each pair has exactly one.
  direct_key       TEXT UNIQUE,
  created_by       TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at       INTEGER NOT NULL,
  last_seq         INTEGER NOT NULL DEFAULT 0,
  last_message_at  INTEGER
);

CREATE TABLE conversation_members (
  conversation_id     TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role                TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  joined_at           INTEGER NOT NULL,
  last_delivered_seq  INTEGER NOT NULL DEFAULT 0,
  last_read_seq       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_members_user_id ON conversation_members (user_id);

CREATE TABLE messages (
  id                TEXT PRIMARY KEY,               -- client-generated UUID (idempotency key)
  conversation_id   TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,               -- assigned by the ConversationRoom DO
  sender_id         TEXT NOT NULL REFERENCES users (id),
  sender_device_id  TEXT,
  kind              TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text')),
  encryption        TEXT NOT NULL DEFAULT 'none' CHECK (encryption IN ('none')),
  body              TEXT NOT NULL,
  reply_to_id       TEXT,
  created_at        INTEGER NOT NULL,
  UNIQUE (conversation_id, seq)
);

-- Read position as shown to other members. Equals last_read_seq unless the
-- reader turned read receipts off (then it stops advancing).
ALTER TABLE conversation_members ADD COLUMN shared_read_seq INTEGER NOT NULL DEFAULT 0;
