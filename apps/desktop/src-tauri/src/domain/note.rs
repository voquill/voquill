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
    pub cloud_owner_user_id: Option<String>,
    pub cloud_on_server: bool,
    pub cloud_unsynced_fields: String,
    pub cloud_process_requested_at: Option<i64>,
    pub cloud_server_updated_at: Option<i64>,
    pub cloud_fetched_updated_at: Option<i64>,
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
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub upload_url: Option<String>,
    pub upload_size_bytes: Option<i64>,
    pub upload_complete: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteDeletion {
    pub note_id: String,
    pub owner_user_id: String,
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteSearchCandidate {
    pub note: Note,
    /// Segment transcripts in index order, separated by blank lines.
    pub transcript: String,
}
