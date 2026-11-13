use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub storage: String,
    pub status: String,
    pub title: String,
    pub title_source: String,
    pub source: String,
    pub personal_notes: String,
    pub generated_notes: Option<String>,
    pub duration_ms: i64,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteSegment {
    pub id: String,
    pub note_id: String,
    pub segment_index: i64,
    pub kind: String,
    pub status: String,
    pub duration_ms: i64,
    pub audio_path: Option<String>,
    pub transcribed_ms: i64,
    pub transcript_text: Option<String>,
    /// JSON array of utterances.
    pub transcript_utterances: Option<String>,
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteSearchCandidate {
    pub note: Note,
    /// Segment transcripts in index order, separated by blank lines.
    pub transcript: String,
}
