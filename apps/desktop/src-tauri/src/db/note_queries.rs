use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqlitePool};

use crate::domain::{Note, NoteSearchCandidate, NoteSegment};

const NOTE_COLUMNS: &str = "id, storage, status, title, title_source, source, personal_notes,
     generated_notes, duration_ms, error_code, error_message, created_at, updated_at";

const SEGMENT_COLUMNS: &str = "id, note_id, segment_index, kind, status, duration_ms, audio_path,
     transcribed_ms, transcript_text, transcript_utterances, created_at";

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
    }
}

pub async fn upsert_note(pool: SqlitePool, note: &Note) -> Result<Note, sqlx::Error> {
    sqlx::query(&format!(
        "INSERT INTO notes ({NOTE_COLUMNS})
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
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
             updated_at = excluded.updated_at"
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
    .execute(&pool)
    .await?;

    Ok(note.clone())
}

pub async fn fetch_notes(pool: SqlitePool) -> Result<Vec<Note>, sqlx::Error> {
    let rows = sqlx::query(&format!(
        "SELECT {NOTE_COLUMNS} FROM notes ORDER BY created_at DESC"
    ))
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
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
             segment_index = excluded.segment_index,
             kind = excluded.kind,
             status = excluded.status,
             duration_ms = excluded.duration_ms,
             audio_path = excluded.audio_path,
             transcribed_ms = excluded.transcribed_ms,
             transcript_text = excluded.transcript_text,
             transcript_utterances = excluded.transcript_utterances"
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

/// Notes containing every term (`match_all`) or any term in their title, AI
/// notes, personal notes or transcript, newest first.
pub async fn search_notes(
    pool: SqlitePool,
    terms: &[String],
    match_all: bool,
    limit: u32,
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

    let sql = format!(
        "SELECT n.id, n.storage, n.status, n.title, n.title_source, n.source,
                n.personal_notes, n.generated_notes, n.duration_ms, n.error_code,
                n.error_message, n.created_at, n.updated_at,
                IFNULL((SELECT group_concat(transcript_text, char(10) || char(10))
                        FROM (SELECT transcript_text FROM note_segments s
                              WHERE s.note_id = n.id AND s.transcript_text IS NOT NULL
                              ORDER BY s.segment_index)), '') AS transcript
         FROM notes n
         WHERE {}
         ORDER BY n.created_at DESC
         LIMIT ?{limit_index}",
        conditions.join(joiner)
    );

    let mut query = sqlx::query(&sql);
    for term in terms {
        query = query.bind(like_pattern(term));
    }
    let rows = query.bind(limit).fetch_all(&pool).await?;

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
        sqlx::raw_sql(crate::db::NOTES_MIGRATION_SQL)
            .execute(&pool)
            .await
            .unwrap();
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

            let notes = fetch_notes(pool.clone()).await.unwrap();
            assert_eq!(notes.len(), 1);
            assert_eq!(notes[0].title, "Renamed");
            assert_eq!(fetch_segments(pool.clone(), "a").await.unwrap().len(), 1);

            delete_note(pool.clone(), "a").await.unwrap();
            assert!(fetch_notes(pool.clone()).await.unwrap().is_empty());
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

            let any = search_notes(pool.clone(), &["budget".to_string()], true, 10)
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
            )
            .await
            .unwrap();
            assert_eq!(all.len(), 1);

            let literal_percent = search_notes(pool.clone(), &["0%".to_string()], false, 10)
                .await
                .unwrap();
            assert_eq!(literal_percent.len(), 1);
            let escaped = search_notes(pool, &["x%".to_string()], false, 10)
                .await
                .unwrap();
            assert!(escaped.is_empty());
        });
    }
}
