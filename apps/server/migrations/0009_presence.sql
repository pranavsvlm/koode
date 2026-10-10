-- Presence (Phase 11): whether someone is connected, when they last were, and
-- whether they show it. Maintained by each user's UserSocket Durable Object.
ALTER TABLE users ADD COLUMN online INTEGER NOT NULL DEFAULT 0 CHECK (online IN (0, 1));
ALTER TABLE users ADD COLUMN last_seen_at INTEGER;
ALTER TABLE users ADD COLUMN last_seen_visibility TEXT NOT NULL DEFAULT 'contacts'
  CHECK (last_seen_visibility IN ('contacts', 'nobody'));
