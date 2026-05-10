use sqlx::{sqlite::SqliteRow, Row, SqlitePool};

use crate::domain::{DictationIntent, Transcription, TranscriptionAudioSnapshot};

fn serialize_warnings(warnings: &Option<Vec<String>>) -> Option<String> {
    warnings
        .as_ref()
        .and_then(|list| serde_json::to_string(list).ok())
}

fn serialize_dictation_intent(intent: &Option<DictationIntent>) -> Option<String> {
    intent
        .as_ref()
        .and_then(|value| serde_json::to_string(value).ok())
}

fn row_to_transcription(row: SqliteRow) -> Result<Transcription, sqlx::Error> {
    let audio_path: Option<String> = row.try_get("audio_path")?;
    let audio_duration: Option<i64> = row.try_get("audio_duration_ms")?;
    let warnings_json: Option<String> = row.try_get("warnings_json")?;
    let dictation_intent_json: Option<String> = row.try_get("dictation_intent_json")?;

    let audio = audio_path.map(|file_path| TranscriptionAudioSnapshot {
        file_path,
        duration_ms: audio_duration.unwrap_or_default(),
    });
    let warnings = warnings_json.and_then(|json| serde_json::from_str::<Vec<String>>(&json).ok());
    let dictation_intent =
        dictation_intent_json.and_then(|json| serde_json::from_str::<DictationIntent>(&json).ok());
    let remote_status: Option<String> = row.try_get("remote_status")?;
    let remote_device_id: Option<String> = row.try_get("remote_device_id")?;

    Ok(Transcription {
        id: row.get::<String, _>("id"),
        transcript: row.get::<String, _>("transcript"),
        timestamp: row.get::<i64, _>("timestamp"),
        audio,
        model_size: row.try_get::<Option<String>, _>("model_size")?,
        inference_device: row.try_get::<Option<String>, _>("inference_device")?,
        raw_transcript: row.try_get::<Option<String>, _>("raw_transcript")?,
        authoritative_transcript: row.try_get::<Option<String>, _>("authoritative_transcript")?,
        is_authoritative: row.try_get::<Option<bool>, _>("is_authoritative")?,
        is_finalized: row.try_get::<Option<bool>, _>("is_finalized")?,
        dictation_intent,
        sanitized_transcript: row.try_get::<Option<String>, _>("sanitized_transcript")?,
        transcription_prompt: row.try_get::<Option<String>, _>("transcription_prompt")?,
        post_process_prompt: row.try_get::<Option<String>, _>("post_process_prompt")?,
        transcription_api_key_id: row.try_get::<Option<String>, _>("transcription_api_key_id")?,
        post_process_api_key_id: row.try_get::<Option<String>, _>("post_process_api_key_id")?,
        transcription_mode: row.try_get::<Option<String>, _>("transcription_mode")?,
        post_process_mode: row.try_get::<Option<String>, _>("post_process_mode")?,
        post_process_device: row.try_get::<Option<String>, _>("post_process_device")?,
        transcription_duration_ms: row.try_get::<Option<i64>, _>("transcription_duration_ms")?,
        postprocess_duration_ms: row.try_get::<Option<i64>, _>("postprocess_duration_ms")?,
        warnings,
        remote_status,
        remote_device_id,
    })
}

pub async fn insert_transcription(
    pool: SqlitePool,
    transcription: &Transcription,
) -> Result<Transcription, sqlx::Error> {
    sqlx::query(
        "INSERT INTO transcriptions (
             id,
             transcript,
             timestamp,
             audio_path,
             audio_duration_ms,
             model_size,
             inference_device,
             raw_transcript,
             authoritative_transcript,
             is_authoritative,
             is_finalized,
             dictation_intent_json,
             sanitized_transcript,
             transcription_prompt,
             post_process_prompt,
             transcription_api_key_id,
             post_process_api_key_id,
             transcription_mode,
             post_process_mode,
             post_process_device,
             transcription_duration_ms,
             postprocess_duration_ms,
             warnings_json,
             remote_status,
             remote_device_id
          )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)",
    )
    .bind(&transcription.id)
    .bind(&transcription.transcript)
    .bind(transcription.timestamp)
    .bind(
        transcription
            .audio
            .as_ref()
            .map(|audio| audio.file_path.as_str()),
    )
    .bind(transcription.audio.as_ref().map(|audio| audio.duration_ms))
    .bind(transcription.model_size.as_deref())
    .bind(transcription.inference_device.as_deref())
    .bind(transcription.raw_transcript.as_deref())
    .bind(transcription.authoritative_transcript.as_deref())
    .bind(transcription.is_authoritative)
    .bind(transcription.is_finalized)
    .bind(serialize_dictation_intent(&transcription.dictation_intent))
    .bind(transcription.sanitized_transcript.as_deref())
    .bind(transcription.transcription_prompt.as_deref())
    .bind(transcription.post_process_prompt.as_deref())
    .bind(transcription.transcription_api_key_id.as_deref())
    .bind(transcription.post_process_api_key_id.as_deref())
    .bind(transcription.transcription_mode.as_deref())
    .bind(transcription.post_process_mode.as_deref())
    .bind(transcription.post_process_device.as_deref())
    .bind(transcription.transcription_duration_ms)
    .bind(transcription.postprocess_duration_ms)
    .bind(serialize_warnings(&transcription.warnings))
    .bind(transcription.remote_status.as_deref())
    .bind(transcription.remote_device_id.as_deref())
    .execute(&pool)
    .await?;

    Ok(transcription.clone())
}

pub async fn fetch_transcriptions(
    pool: SqlitePool,
    limit: u32,
    offset: u32,
) -> Result<Vec<Transcription>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id,
                transcript,
                timestamp,
                audio_path,
                audio_duration_ms,
                model_size,
                inference_device,
                raw_transcript,
                authoritative_transcript,
                is_authoritative,
                is_finalized,
                dictation_intent_json,
                sanitized_transcript,
                transcription_prompt,
                post_process_prompt,
                transcription_api_key_id,
                post_process_api_key_id,
                transcription_mode,
                post_process_mode,
                post_process_device,
                transcription_duration_ms,
                postprocess_duration_ms,
                warnings_json,
                remote_status,
                remote_device_id
         FROM transcriptions
         ORDER BY timestamp DESC
         LIMIT ?1 OFFSET ?2",
    )
    .bind(limit as i64)
    .bind(offset as i64)
    .fetch_all(&pool)
    .await?;

    let mut transcriptions = Vec::with_capacity(rows.len());

    for row in rows {
        transcriptions.push(row_to_transcription(row)?);
    }

    Ok(transcriptions)
}

pub async fn update_transcription(
    pool: SqlitePool,
    transcription: &Transcription,
) -> Result<Transcription, sqlx::Error> {
    sqlx::query(
        "UPDATE transcriptions
         SET transcript = ?2,
             timestamp = ?3,
             audio_path = ?4,
             audio_duration_ms = ?5,
             model_size = ?6,
             inference_device = ?7,
             raw_transcript = ?8,
              authoritative_transcript = ?9,
              is_authoritative = ?10,
              is_finalized = ?11,
              dictation_intent_json = ?12,
              sanitized_transcript = ?13,
              transcription_prompt = ?14,
              post_process_prompt = ?15,
              transcription_api_key_id = ?16,
              post_process_api_key_id = ?17,
              transcription_mode = ?18,
              post_process_mode = ?19,
              post_process_device = ?20,
              transcription_duration_ms = ?21,
              postprocess_duration_ms = ?22,
              warnings_json = ?23,
              remote_status = ?24,
              remote_device_id = ?25
          WHERE id = ?1",
    )
    .bind(&transcription.id)
    .bind(&transcription.transcript)
    .bind(transcription.timestamp)
    .bind(
        transcription
            .audio
            .as_ref()
            .map(|audio| audio.file_path.as_str()),
    )
    .bind(transcription.audio.as_ref().map(|audio| audio.duration_ms))
    .bind(transcription.model_size.as_deref())
    .bind(transcription.inference_device.as_deref())
    .bind(transcription.raw_transcript.as_deref())
    .bind(transcription.authoritative_transcript.as_deref())
    .bind(transcription.is_authoritative)
    .bind(transcription.is_finalized)
    .bind(serialize_dictation_intent(&transcription.dictation_intent))
    .bind(transcription.sanitized_transcript.as_deref())
    .bind(transcription.transcription_prompt.as_deref())
    .bind(transcription.post_process_prompt.as_deref())
    .bind(transcription.transcription_api_key_id.as_deref())
    .bind(transcription.post_process_api_key_id.as_deref())
    .bind(transcription.transcription_mode.as_deref())
    .bind(transcription.post_process_mode.as_deref())
    .bind(transcription.post_process_device.as_deref())
    .bind(transcription.transcription_duration_ms)
    .bind(transcription.postprocess_duration_ms)
    .bind(serialize_warnings(&transcription.warnings))
    .bind(transcription.remote_status.as_deref())
    .bind(transcription.remote_device_id.as_deref())
    .execute(&pool)
    .await?;

    let row = sqlx::query(
        "SELECT id,
                transcript,
                timestamp,
                audio_path,
                audio_duration_ms,
                model_size,
                inference_device,
                raw_transcript,
                authoritative_transcript,
                is_authoritative,
                is_finalized,
                dictation_intent_json,
                sanitized_transcript,
                transcription_prompt,
                post_process_prompt,
                transcription_api_key_id,
                post_process_api_key_id,
                transcription_mode,
                post_process_mode,
                post_process_device,
                transcription_duration_ms,
                postprocess_duration_ms,
                warnings_json,
                remote_status,
                remote_device_id
         FROM transcriptions
         WHERE id = ?1",
    )
    .bind(&transcription.id)
    .fetch_optional(&pool)
    .await?
    .ok_or(sqlx::Error::RowNotFound)?;

    row_to_transcription(row)
}

pub async fn delete_transcription(pool: SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "DELETE FROM transcriptions
         WHERE id = ?1",
    )
    .bind(id)
    .execute(&pool)
    .await?;

    Ok(())
}
