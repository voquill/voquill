-- Cloud sync bookkeeping for Voquill Notes. Cloud notes are scoped to the
-- account that owns them (cloud_owner_user_id); local notes leave it NULL.
ALTER TABLE notes ADD COLUMN cloud_owner_user_id TEXT;
ALTER TABLE notes ADD COLUMN cloud_on_server INTEGER NOT NULL DEFAULT 0;
-- Comma-separated editable fields changed here but not yet confirmed by the server.
ALTER TABLE notes ADD COLUMN cloud_unsynced_fields TEXT NOT NULL DEFAULT '';
ALTER TABLE notes ADD COLUMN cloud_process_requested_at INTEGER;
-- The server's updatedAt as last seen, and the one the cached segments match.
ALTER TABLE notes ADD COLUMN cloud_server_updated_at INTEGER;
ALTER TABLE notes ADD COLUMN cloud_fetched_updated_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_notes_cloud_owner ON notes (cloud_owner_user_id);

ALTER TABLE note_segments ADD COLUMN error_code TEXT;
ALTER TABLE note_segments ADD COLUMN error_message TEXT;
ALTER TABLE note_segments ADD COLUMN upload_url TEXT;
ALTER TABLE note_segments ADD COLUMN upload_size_bytes INTEGER;
ALTER TABLE note_segments ADD COLUMN upload_complete INTEGER NOT NULL DEFAULT 0;

-- Cloud notes deleted on this device whose server delete has not gone through yet.
CREATE TABLE IF NOT EXISTS note_deletions (
    note_id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
