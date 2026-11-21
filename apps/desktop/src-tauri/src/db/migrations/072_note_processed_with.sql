-- Where a local note's transcript and AI notes were produced (JSON).
ALTER TABLE notes ADD COLUMN processed_with TEXT;

-- Two devices resuming the same cloud note can each add a segment at the
-- same index; ordering ties are broken by creation time instead.
DROP INDEX IF EXISTS idx_note_segments_note_index;
CREATE INDEX IF NOT EXISTS idx_note_segments_note_index
    ON note_segments (note_id, segment_index);
