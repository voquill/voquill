ALTER TABLE transcriptions ADD COLUMN authoritative_transcript TEXT;
ALTER TABLE transcriptions ADD COLUMN is_authoritative INTEGER;
ALTER TABLE transcriptions ADD COLUMN is_finalized INTEGER;
ALTER TABLE transcriptions ADD COLUMN dictation_intent_json TEXT;
