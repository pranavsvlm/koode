-- Migration 0008: indexes and a denormalized column for hot queries
-- (measured in Phase 9; see PROGRESS.md).

-- The newest message that counts as activity (not a reaction), so conversation
-- summaries find it with one index lookup instead of scanning the chat.
ALTER TABLE conversations ADD COLUMN last_message_seq INTEGER NOT NULL DEFAULT 0;
UPDATE conversations SET last_message_seq = COALESCE(
  (SELECT MAX(seq) FROM messages WHERE conversation_id = conversations.id AND kind != 'reaction'), 0);

-- Every call request expires stale ringing calls; without this it scans all calls.
CREATE INDEX calls_ringing ON calls (created_at) WHERE state = 'ringing';
