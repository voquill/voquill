use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqlitePool};

use crate::domain::{Note, NoteDeletion, NoteSearchCandidate, NoteSegment};

const NOTE_COLUMNS: &str = "id, storage, status, title, title_source, source, personal_notes,
     generated_notes, duration_ms, error_code, error_message, created_at, updated_at,
     cloud_owner_user_id, cloud_on_server, cloud_unsynced_fields, cloud_process_requested_at,
     cloud_server_updated_at, cloud_fetched_updated_at, error_details";

const SEGMENT_COLUMNS: &str = "id, note_id, segment_index, kind, status, duration_ms, audio_path,
     transcribed_ms, transcript_text, transcript_utterances, created_at, error_code,
     error_message, upload_url, upload_size_bytes, upload_complete, error_details";

fn row_to_note(row: &SqliteRow) -> Note {
    Note {
        id: row.get("id"),
        storage: row.get("storage"),
        status: row.get("status"),
        title: row.get("title"),
        title_source: row.get("title_source"),
        source: row.get("source"),
        personal_notes: row.get("personal_notes"),
        generated_notes: row.get("generated_notes"),
        duration_ms: row.get("duration_ms"),
        error_code: row.get("error_code"),
        error_message: row.get("error_message"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        cloud_owner_user_id: row.get("cloud_owner_user_id"),
        cloud_on_server: row.get("cloud_on_server"),
        cloud_unsynced_fields: row.get("cloud_unsynced_fields"),
        cloud_process_requested_at: row.get("cloud_process_requested_at"),
        cloud_server_updated_at: row.get("cloud_server_updated_at"),
        cloud_fetched_updated_at: row.get("cloud_fetched_updated_at"),
        error_details: row.get("error_details"),
    }
}

fn row_to_segment(row: &SqliteRow) -> NoteSegment {
    NoteSegment {
        id: row.get("id"),
        note_id: row.get("note_id"),
        segment_index: row.get("segment_index"),
        kind: row.get("kind"),
        status: row.get("status"),
        duration_ms: row.get("duration_ms"),
        audio_path: row.get("audio_path"),
        transcribed_ms: row.get("transcribed_ms"),
        transcript_text: row.get("transcript_text"),
        transcript_utterances: row.get("transcript_utterances"),
        created_at: row.get("created_at"),
        error_code: row.get("error_code"),
        error_message: row.get("error_message"),
        upload_url: row.get("upload_url"),
        upload_size_bytes: row.get("upload_size_bytes"),
        upload_complete: row.get("upload_complete"),
        error_details: row.get("error_details"),
    }
}

pub async fn upsert_note(pool: SqlitePool, note: &Note) -> Result<Note, sqlx::Error> {
    sqlx::query(&format!(
        "INSERT INTO notes ({NOTE_COLUMNS})
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
         ON CONFLICT(id) DO UPDATE SET
             storage = excluded.storage,
             status = excluded.status,
             title = excluded.title,
             title_source = excluded.title_source,
             source = excluded.source,
             personal_notes = excluded.personal_notes,
             generated_notes = excluded.generated_notes,
             duration_ms = excluded.duration_ms,
             error_code = excluded.error_code,
             error_message = excluded.error_message,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at,
             cloud_owner_user_id = excluded.cloud_owner_user_id,
             cloud_on_server = excluded.cloud_on_server,
             cloud_unsynced_fields = excluded.cloud_unsynced_fields,
             cloud_process_requested_at = excluded.cloud_process_requested_at,
             cloud_server_updated_at = excluded.cloud_server_updated_at,
             cloud_fetched_updated_at = excluded.cloud_fetched_updated_at,
             error_details = excluded.error_details"
    ))
    .bind(&note.id)
    .bind(&note.storage)
    .bind(&note.status)
    .bind(&note.title)
    .bind(&note.title_source)
    .bind(&note.source)
    .bind(&note.personal_notes)
    .bind(&note.generated_notes)
    .bind(note.duration_ms)
    .bind(&note.error_code)
    .bind(&note.error_message)
    .bind(note.created_at)
    .bind(note.updated_at)
    .bind(&note.cloud_owner_user_id)
    .bind(note.cloud_on_server)
    .bind(&note.cloud_unsynced_fields)
    .bind(note.cloud_process_requested_at)
    .bind(note.cloud_server_updated_at)
    .bind(note.cloud_fetched_updated_at)
    .bind(&note.error_details)
    .execute(&pool)
    .await?;

    Ok(note.clone())
}

/// Local notes plus the cloud notes of `cloud_owner_user_id`, newest first.
pub async fn fetch_notes(
    pool: SqlitePool,
    cloud_owner_user_id: Option<&str>,
) -> Result<Vec<Note>, sqlx::Error> {
    let rows = sqlx::query(&format!(
        "SELECT {NOTE_COLUMNS} FROM notes
         WHERE storage = 'local' OR cloud_owner_user_id = ?1
         ORDER BY created_at DESC"
    ))
    .bind(cloud_owner_user_id)
    .fetch_all(&pool)
    .await?;

    Ok(rows.iter().map(row_to_note).collect())
}

pub async fn delete_note(pool: SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    let mut transaction = pool.begin().await?;
    sqlx::query("DELETE FROM note_segments WHERE note_id = ?1")
        .bind(id)
        .execute(&mut *transaction)
        .await?;
    sqlx::query("DELETE FROM notes WHERE id = ?1")
        .bind(id)
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await
}

pub async fn upsert_segment(
    pool: SqlitePool,
    segment: &NoteSegment,
) -> Result<NoteSegment, sqlx::Error> {
    sqlx::query(&format!(
        "INSERT INTO note_segments ({SEGMENT_COLUMNS})
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
         ON CONFLICT(id) DO UPDATE SET
             segment_index = excluded.segment_index,
             kind = excluded.kind,
             status = excluded.status,
             duration_ms = excluded.duration_ms,
             audio_path = excluded.audio_path,
             transcribed_ms = excluded.transcribed_ms,
             transcript_text = excluded.transcript_text,
             transcript_utterances = excluded.transcript_utterances,
             error_code = excluded.error_code,
             error_message = excluded.error_message,
             upload_url = excluded.upload_url,
             upload_size_bytes = excluded.upload_size_bytes,
             upload_complete = excluded.upload_complete,
             error_details = excluded.error_details"
    ))
    .bind(&segment.id)
    .bind(&segment.note_id)
    .bind(segment.segment_index)
    .bind(&segment.kind)
    .bind(&segment.status)
    .bind(segment.duration_ms)
    .bind(&segment.audio_path)
    .bind(segment.transcribed_ms)
    .bind(&segment.transcript_text)
    .bind(&segment.transcript_utterances)
    .bind(segment.created_at)
    .bind(&segment.error_code)
    .bind(&segment.error_message)
    .bind(&segment.upload_url)
    .bind(segment.upload_size_bytes)
    .bind(segment.upload_complete)
    .bind(&segment.error_details)
    .execute(&pool)
    .await?;

    Ok(segment.clone())
}

pub async fn fetch_segments(
    pool: SqlitePool,
    note_id: &str,
) -> Result<Vec<NoteSegment>, sqlx::Error> {
    let rows = sqlx::query(&format!(
        "SELECT {SEGMENT_COLUMNS} FROM note_segments
         WHERE note_id = ?1
         ORDER BY segment_index ASC"
    ))
    .bind(note_id)
    .fetch_all(&pool)
    .await?;

    Ok(rows.iter().map(row_to_segment).collect())
}

fn like_pattern(term: &str) -> String {
    let escaped = term
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

pub async fn delete_segment(
    pool: SqlitePool,
    note_id: &str,
    segment_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM note_segments WHERE note_id = ?1 AND id = ?2")
        .bind(note_id)
        .bind(segment_id)
        .execute(&pool)
        .await?;
    Ok(())
}

pub async fn upsert_deletion(pool: SqlitePool, deletion: &NoteDeletion) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO note_deletions (note_id, owner_user_id, created_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(note_id) DO NOTHING",
    )
    .bind(&deletion.note_id)
    .bind(&deletion.owner_user_id)
    .bind(deletion.created_at)
    .execute(&pool)
    .await?;
    Ok(())
}

pub async fn fetch_deletions(
    pool: SqlitePool,
    owner_user_id: &str,
) -> Result<Vec<NoteDeletion>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT note_id, owner_user_id, created_at FROM note_deletions
         WHERE owner_user_id = ?1 ORDER BY created_at ASC",
    )
    .bind(owner_user_id)
    .fetch_all(&pool)
    .await?;
    Ok(rows
        .iter()
        .map(|row| NoteDeletion {
            note_id: row.get("note_id"),
            owner_user_id: row.get("owner_user_id"),
            created_at: row.get("created_at"),
        })
        .collect())
}

pub async fn delete_deletion(pool: SqlitePool, note_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM note_deletions WHERE note_id = ?1")
        .bind(note_id)
        .execute(&pool)
        .await?;
    Ok(())
}

/// Visible notes (as in `fetch_notes`) containing every term (`match_all`) or
/// any term in their title, AI notes, personal notes or transcript, newest
/// first.
pub async fn search_notes(
    pool: SqlitePool,
    terms: &[String],
    match_all: bool,
    limit: u32,
    cloud_owner_user_id: Option<&str>,
) -> Result<Vec<NoteSearchCandidate>, sqlx::Error> {
    if terms.is_empty() {
        return Ok(Vec::new());
    }

    let conditions: Vec<String> = (1..=terms.len())
        .map(|index| {
            format!(
                "(n.title LIKE ?{index} ESCAPE '\\'
                  OR n.personal_notes LIKE ?{index} ESCAPE '\\'
                  OR IFNULL(n.generated_notes, '') LIKE ?{index} ESCAPE '\\'
                  OR EXISTS (SELECT 1 FROM note_segments s
                             WHERE s.note_id = n.id
                               AND s.transcript_text LIKE ?{index} ESCAPE '\\'))"
            )
        })
        .collect();
    let joiner = if match_all { " AND " } else { " OR " };
    let limit_index = terms.len() + 1;
    let owner_index = terms.len() + 2;

    let sql = format!(
        "SELECT {},
                IFNULL((SELECT group_concat(transcript_text, char(10) || char(10))
                        FROM (SELECT transcript_text FROM note_segments s
                              WHERE s.note_id = n.id AND s.transcript_text IS NOT NULL
                              ORDER BY s.segment_index)), '') AS transcript
         FROM notes n
         WHERE (n.storage = 'local' OR n.cloud_owner_user_id = ?{owner_index}) AND ({})
         ORDER BY n.created_at DESC
         LIMIT ?{limit_index}",
        NOTE_COLUMNS
            .split(',')
            .map(|column| format!("n.{}", column.trim()))
            .collect::<Vec<_>>()
            .join(", "),
        conditions.join(joiner)
    );

    let mut query = sqlx::query(&sql);
    for term in terms {
        query = query.bind(like_pattern(term));
    }
    let rows = query
        .bind(limit)
        .bind(cloud_owner_user_id)
        .fetch_all(&pool)
        .await?;

    Ok(rows
        .iter()
        .map(|row| NoteSearchCandidate {
            note: row_to_note(row),
            transcript: row.get("transcript"),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for sql in [
            crate::db::NOTES_MIGRATION_SQL,
            crate::db::NOTE_CLOUD_SYNC_MIGRATION_SQL,
        ] {
            sqlx::raw_sql(sql).execute(&pool).await.unwrap();
        }
        pool
    }

    fn note(id: &str, title: &str, created_at: i64) -> Note {
        Note {
            id: id.to_string(),
            storage: "local".to_string(),
            status: "ready".to_string(),
            title: title.to_string(),
            title_source: "ai".to_string(),
            source: "recording".to_string(),
            personal_notes: String::new(),
            generated_notes: None,
            duration_ms: 0,
            error_code: None,
            error_message: None,
            created_at,
            updated_at: created_at,
            cloud_owner_user_id: None,
            cloud_on_server: false,
            cloud_unsynced_fields: String::new(),
            cloud_process_requested_at: None,
            cloud_server_updated_at: None,
            cloud_fetched_updated_at: None,
            error_details: None,
        }
    }

    fn segment(id: &str, note_id: &str, index: i64, text: &str) -> NoteSegment {
        NoteSegment {
            id: id.to_string(),
            note_id: note_id.to_string(),
            segment_index: index,
            kind: "audio".to_string(),
            status: "transcribed".to_string(),
            duration_ms: 1_000,
            audio_path: None,
            transcribed_ms: 1_000,
            transcript_text: Some(text.to_string()),
            transcript_utterances: Some("[]".to_string()),
            created_at: 0,
            error_code: None,
            error_message: None,
            upload_url: None,
            upload_size_bytes: None,
            upload_complete: false,
            error_details: None,
        }
    }

    #[test]
    fn upserts_and_deletes_notes_with_segments() {
        tauri::async_runtime::block_on(async {
            let pool = pool().await;
            upsert_note(pool.clone(), &note("a", "First", 1))
                .await
                .unwrap();
            let mut renamed = note("a", "Renamed", 1);
            renamed.updated_at = 5;
            upsert_note(pool.clone(), &renamed).await.unwrap();
            upsert_segment(pool.clone(), &segment("s1", "a", 0, "hello"))
                .await
                .unwrap();

            let notes = fetch_notes(pool.clone(), None).await.unwrap();
            assert_eq!(notes.len(), 1);
            assert_eq!(notes[0].title, "Renamed");
            assert_eq!(fetch_segments(pool.clone(), "a").await.unwrap().len(), 1);

            delete_note(pool.clone(), "a").await.unwrap();
            assert!(fetch_notes(pool.clone(), None).await.unwrap().is_empty());
            assert!(fetch_segments(pool, "a").await.unwrap().is_empty());
        });
    }

    #[test]
    fn searches_every_field_and_stitches_transcripts_in_order() {
        tauri::async_runtime::block_on(async {
            let pool = pool().await;
            upsert_note(pool.clone(), &note("a", "Budget review", 1))
                .await
                .unwrap();
            upsert_note(pool.clone(), &note("b", "Standup", 2))
                .await
                .unwrap();
            upsert_segment(pool.clone(), &segment("s2", "b", 1, "second 100%"))
                .await
                .unwrap();
            upsert_segment(pool.clone(), &segment("s1", "b", 0, "first budget"))
                .await
                .unwrap();

            let any = search_notes(pool.clone(), &["budget".to_string()], true, 10, None)
                .await
                .unwrap();
            assert_eq!(
                any.iter().map(|c| c.note.id.as_str()).collect::<Vec<_>>(),
                vec!["b", "a"]
            );
            assert_eq!(any[0].transcript, "first budget\n\nsecond 100%");

            let all = search_notes(
                pool.clone(),
                &["budget".to_string(), "second".to_string()],
                true,
                10,
                None,
            )
            .await
            .unwrap();
            assert_eq!(all.len(), 1);

            let literal_percent = search_notes(pool.clone(), &["0%".to_string()], false, 10, None)
                .await
                .unwrap();
            assert_eq!(literal_percent.len(), 1);
            let escaped = search_notes(pool, &["x%".to_string()], false, 10, None)
                .await
                .unwrap();
            assert!(escaped.is_empty());
        });
    }

    fn cloud_note(id: &str, owner: &str) -> Note {
        let mut note = note(id, "Budget", 3);
        note.storage = "cloud".to_string();
        note.cloud_owner_user_id = Some(owner.to_string());
        note.cloud_on_server = true;
        note.cloud_unsynced_fields = "title".to_string();
        note.cloud_process_requested_at = Some(9);
        note
    }

    #[test]
    fn scopes_cloud_notes_to_their_owner() {
        tauri::async_runtime::block_on(async {
            let pool = pool().await;
            upsert_note(pool.clone(), &note("local", "Budget", 1))
                .await
                .unwrap();
            upsert_note(pool.clone(), &cloud_note("a", "user-a"))
                .await
                .unwrap();
            upsert_note(pool.clone(), &cloud_note("b", "user-b"))
                .await
                .unwrap();

            let ids = |notes: Vec<Note>| notes.into_iter().map(|n| n.id).collect::<Vec<_>>();
            assert_eq!(
                ids(fetch_notes(pool.clone(), Some("user-a")).await.unwrap()),
                vec!["a", "local"]
            );
            assert_eq!(
                ids(fetch_notes(pool.clone(), None).await.unwrap()),
                vec!["local"]
            );

            let found = search_notes(
                pool.clone(),
                &["budget".to_string()],
                true,
                10,
                Some("user-b"),
            )
            .await
            .unwrap();
            assert_eq!(
                found.iter().map(|c| c.note.id.as_str()).collect::<Vec<_>>(),
                vec!["b", "local"]
            );

            let stored = &fetch_notes(pool, Some("user-a")).await.unwrap()[0];
            assert!(stored.cloud_on_server);
            assert_eq!(stored.cloud_unsynced_fields, "title");
            assert_eq!(stored.cloud_process_requested_at, Some(9));
        });
    }

    #[test]
    fn keeps_deletions_per_owner_and_deletes_single_segments() {
        tauri::async_runtime::block_on(async {
            let pool = pool().await;
            for (note_id, owner) in [("a", "user-a"), ("b", "user-b")] {
                upsert_deletion(
                    pool.clone(),
                    &NoteDeletion {
                        note_id: note_id.to_string(),
                        owner_user_id: owner.to_string(),
                        created_at: 1,
                    },
                )
                .await
                .unwrap();
            }
            let pending = fetch_deletions(pool.clone(), "user-a").await.unwrap();
            assert_eq!(pending.len(), 1);
            delete_deletion(pool.clone(), "a").await.unwrap();
            assert!(fetch_deletions(pool.clone(), "user-a")
                .await
                .unwrap()
                .is_empty());

            upsert_note(pool.clone(), &note("n", "N", 1)).await.unwrap();
            let mut uploading = segment("s1", "n", 0, "x");
            uploading.upload_url = Some("https://upload".to_string());
            uploading.upload_size_bytes = Some(44);
            uploading.upload_complete = true;
            upsert_segment(pool.clone(), &uploading).await.unwrap();
            upsert_segment(pool.clone(), &segment("s2", "n", 1, "y"))
                .await
                .unwrap();
            let stored = fetch_segments(pool.clone(), "n").await.unwrap();
            assert_eq!(stored[0].upload_url.as_deref(), Some("https://upload"));
            assert!(stored[0].upload_complete);
            delete_segment(pool.clone(), "n", "s1").await.unwrap();
            assert_eq!(fetch_segments(pool, "n").await.unwrap().len(), 1);
        });
    }
}
