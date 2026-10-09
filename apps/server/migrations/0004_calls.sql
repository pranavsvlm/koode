-- Migration 0004: one-to-one calls (signalling state; media flows via LiveKit).

CREATE TABLE calls (
  id           TEXT PRIMARY KEY,          -- also the LiveKit room name (unguessable)
  kind         TEXT NOT NULL CHECK (kind IN ('voice', 'video')),
  caller_id    TEXT NOT NULL REFERENCES users (id),
  callee_id    TEXT NOT NULL REFERENCES users (id),
  state        TEXT NOT NULL CHECK (state IN ('ringing', 'active', 'ended', 'declined', 'cancelled', 'missed')),
  created_at   INTEGER NOT NULL,
  answered_at  INTEGER,
  ended_at     INTEGER
);
CREATE INDEX calls_caller ON calls (caller_id, created_at);
CREATE INDEX calls_callee ON calls (callee_id, created_at);
CREATE INDEX calls_open ON calls (state) WHERE state IN ('ringing', 'active');
