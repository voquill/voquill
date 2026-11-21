-- Voquill Notes. Holds local notes and, once cloud sync exists, the on-device
-- copy of cloud notes (storage = 'cloud') so listing, offline viewing and text
-- search work from one place.
CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    storage TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    title_source TEXT NOT NULL,
    source TEXT NOT NULL,
    personal_notes TEXT NOT NULL DEFAULT '',
    generated_notes TEXT,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_status ON notes (status);

CREATE TABLE IF NOT EXISTS note_segments (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL,
    segment_index INTEGER NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    audio_path TEXT,
    transcribed_ms INTEGER NOT NULL DEFAULT 0,
    transcript_text TEXT,
    transcript_utterances TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_note_segments_note_index
    ON note_segments (note_id, segment_index);
