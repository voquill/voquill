use std::convert::TryInto;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, EventTarget, Manager, State};

use crate::domain::{
    ApiKey, ApiKeyCreateRequest, ApiKeyView, AudioChunkPayload, OverlayPhase, OverlayPhasePayload,
    RecordingLevelPayload, TranscriptionAudioSnapshot, EVT_AUDIO_CHUNK, EVT_OVERLAY_PHASE,
    EVT_REC_LEVEL,
};
use crate::platform::{
    ChunkCallback, GpuDescriptor, LevelCallback, TranscriptionDevice, TranscriptionRequest,
};
use crate::system::crypto::{protect_api_key, reveal_api_key};
use crate::utils::decode_to_utf8;
use crate::system::models::WhisperModelSize;
use crate::system::StorageRepo;
use sqlx::Row;

use crate::platform::input::paste_text_into_focused_field as platform_paste_text;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopRecordingResponse {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRecordingResponse {
    pub sample_rate: u32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentAppInfoResponse {
    pub app_name: String,
    pub icon_base64: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFieldInfo {
    pub cursor_position: Option<usize>,
    pub selection_length: Option<usize>,
    pub text_content: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenContextInfo {
    pub screen_context: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppTargetUpsertArgs {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub tone_id: Option<String>,
    #[serde(default)]
    pub icon_path: Option<String>,
    #[serde(default)]
    pub paste_keybind: Option<String>,
}

#[derive(serde::Deserialize)]
pub enum AudioClip {
    #[serde(rename = "start_recording_clip")]
    StartRecordingClip,
    #[serde(rename = "stop_recording_clip")]
    StopRecordingClip,
    #[serde(rename = "alert_linux_clip")]
    AlertLinuxClip,
    #[serde(rename = "alert_macos_clip")]
    AlertMacosClip,
    #[serde(rename = "alert_windows_10_clip")]
    AlertWindows10Clip,
    #[serde(rename = "alert_windows_11_clip")]
    AlertWindows11Clip,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StartRecordingArgs {
    pub preferred_microphone: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionDeviceSelectionDto {
    #[serde(default)]
    pub cpu: bool,
    pub device_id: Option<u32>,
    pub device_name: Option<String>,
}

impl TranscriptionDeviceSelectionDto {
    fn into_request(self) -> TranscriptionRequest {
        let mut request = TranscriptionRequest::default();

        if self.cpu {
            request.device = Some(TranscriptionDevice::Cpu);
            return request;
        }

        if self.device_id.is_some() || self.device_name.is_some() {
            request.device = Some(TranscriptionDevice::Gpu(GpuDescriptor {
                id: self.device_id,
                name: self.device_name,
            }));
        }

        request
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionOptionsDto {
    #[serde(default)]
    pub device: Option<TranscriptionDeviceSelectionDto>,
    pub model_size: Option<String>,
    pub initial_prompt: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserPreferencesGetArgs {
    pub user_id: String,
}

const MAX_RETAINED_TRANSCRIPTION_AUDIO: usize = 20;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionAudioData {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

async fn delete_audio_entries(
    app: AppHandle,
    entries: Vec<(String, String)>,
) -> Result<Vec<String>, String> {
    if entries.is_empty() {
        return Ok(Vec::new());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let mut removed = Vec::new();
        for (id, path) in entries {
            let file_path = PathBuf::from(&path);
            if let Err(err) = crate::system::audio_store::delete_audio_file(&app, &file_path) {
                eprintln!("Failed to delete audio file for transcription {id}: {err}");
            }
            removed.push(id);
        }
        removed
    })
    .await
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn user_set_one(
    user: crate::domain::User,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<crate::domain::User, String> {
    crate::db::user_queries::upsert_user(database.pool(), &user)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn user_get_one(
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<Option<crate::domain::User>, String> {
    crate::db::user_queries::fetch_user(database.pool())
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn user_preferences_set(
    preferences: crate::domain::UserPreferences,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<crate::domain::UserPreferences, String> {
    crate::db::preferences_queries::upsert_user_preferences(database.pool(), &preferences)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn user_preferences_get(
    args: UserPreferencesGetArgs,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<Option<crate::domain::UserPreferences>, String> {
    crate::db::preferences_queries::fetch_user_preferences(database.pool(), &args.user_id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn start_google_sign_in(
    app_handle: AppHandle,
    config: State<'_, crate::state::GoogleOAuthState>,
) -> Result<(), String> {
    let config = config.config().ok_or_else(|| {
        "Google OAuth client id/secret not configured. Set VOQUILL_GOOGLE_CLIENT_ID and VOQUILL_GOOGLE_CLIENT_SECRET."
            .to_string()
    })?;

    let result = crate::system::google_oauth::start_google_oauth(&app_handle, config).await?;

    app_handle
        .emit_to(
            EventTarget::any(),
            crate::system::google_oauth::GOOGLE_AUTH_EVENT,
            result.payload,
        )
        .map_err(|err| err.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn start_enterprise_oidc_sign_in(
    app_handle: AppHandle,
    gateway_url: String,
    provider_id: String,
) -> Result<(), String> {
    let result = crate::system::enterprise_oidc::start_enterprise_oidc_flow(
        &app_handle,
        &gateway_url,
        &provider_id,
    )
    .await?;

    app_handle
        .emit_to(
            EventTarget::any(),
            crate::system::enterprise_oidc::ENTERPRISE_OIDC_EVENT,
            result,
        )
        .map_err(|err| err.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn list_microphones() -> Vec<crate::platform::audio::InputDeviceDescriptor> {
    crate::platform::audio::list_input_devices()
}

#[tauri::command]
pub fn list_gpus() -> Vec<crate::system::gpu::GpuAdapterInfo> {
    crate::system::gpu::list_available_gpus()
}

#[tauri::command]
pub fn get_monitor_at_cursor() -> Option<crate::domain::MonitorAtCursor> {
    crate::platform::monitor::get_monitor_at_cursor()
}

#[tauri::command]
pub fn get_screen_visible_area() -> crate::domain::ScreenVisibleArea {
    crate::platform::monitor::get_screen_visible_area()
}

#[tauri::command]
pub fn check_microphone_permission() -> Result<crate::domain::PermissionStatus, String> {
    crate::platform::permissions::check_microphone_permission()
}

#[tauri::command]
pub fn request_microphone_permission() -> Result<crate::domain::PermissionStatus, String> {
    crate::platform::permissions::request_microphone_permission()
}

#[tauri::command]
pub fn check_accessibility_permission() -> Result<crate::domain::PermissionStatus, String> {
    crate::platform::permissions::check_accessibility_permission()
}

#[tauri::command]
pub fn request_accessibility_permission() -> Result<crate::domain::PermissionStatus, String> {
    crate::platform::permissions::request_accessibility_permission()
}

#[tauri::command]
pub async fn get_current_app_info() -> Result<CurrentAppInfoResponse, String> {
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tauri::async_runtime::spawn_blocking(|| {
            crate::platform::app_info::get_current_app_info().map(|info| CurrentAppInfoResponse {
                app_name: info.app_name,
                icon_base64: info.icon_base64,
            })
        }),
    )
    .await
    .map_err(|_| "get_current_app_info timed out".to_string())?
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn app_target_upsert(
    args: AppTargetUpsertArgs,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<crate::domain::AppTarget, String> {
    crate::db::app_target_queries::upsert_app_target(
        database.pool(),
        &args.id,
        &args.name,
        args.tone_id,
        args.icon_path,
        args.paste_keybind,
    )
    .await
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn app_target_list(
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<Vec<crate::domain::AppTarget>, String> {
    crate::db::app_target_queries::fetch_app_targets(database.pool())
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn transcription_create(
    transcription: crate::domain::Transcription,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<crate::domain::Transcription, String> {
    crate::db::transcription_queries::insert_transcription(database.pool(), &transcription)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn transcription_list(
    limit: Option<u32>,
    offset: Option<u32>,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<Vec<crate::domain::Transcription>, String> {
    let limit = limit.unwrap_or(20);
    let offset = offset.unwrap_or(0);

    crate::db::transcription_queries::fetch_transcriptions(database.pool(), limit, offset)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn transcription_delete(
    app: AppHandle,
    id: String,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<(), String> {
    let pool = database.pool();

    let audio_path: Option<String> = sqlx::query_scalar(
        "SELECT audio_path
         FROM transcriptions
         WHERE id = ?1",
    )
    .bind(&id)
    .fetch_optional(&pool)
    .await
    .map_err(|err| err.to_string())?;

    if let Some(path) = audio_path {
        delete_audio_entries(app.clone(), vec![(id.clone(), path)]).await?;
    }

    crate::db::transcription_queries::delete_transcription(pool, &id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn transcription_update(
    transcription: crate::domain::Transcription,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<crate::domain::Transcription, String> {
    crate::db::transcription_queries::update_transcription(database.pool(), &transcription)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn transcription_audio_load(
    app: AppHandle,
    id: String,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<TranscriptionAudioData, String> {
    let pool = database.pool();

    let audio_path: Option<String> = sqlx::query_scalar(
        "SELECT audio_path
         FROM transcriptions
         WHERE id = ?1",
    )
    .bind(&id)
    .fetch_optional(&pool)
    .await
    .map_err(|err| err.to_string())?;

    let audio_path = audio_path
        .ok_or_else(|| "No audio snapshot available for this transcription".to_string())?;

    let audio_dir = crate::system::audio_store::audio_dir(&app).map_err(|err| err.to_string())?;
    let audio_path_buf = PathBuf::from(&audio_path);

    if !audio_path_buf.starts_with(&audio_dir) {
        return Err("Audio snapshot path is outside the managed directory".to_string());
    }

    let (samples, sample_rate) = tauri::async_runtime::spawn_blocking(move || {
        crate::system::audio_store::load_audio_samples(&audio_path_buf)
            .map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())??;

    Ok(TranscriptionAudioData {
        samples,
        sample_rate,
    })
}

#[tauri::command]
pub async fn export_transcription(
    app: AppHandle,
    id: String,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<bool, String> {
    let pool = database.pool();

    let row = sqlx::query(
        "SELECT transcript, raw_transcript, audio_path
         FROM transcriptions
         WHERE id = ?1",
    )
    .bind(&id)
    .fetch_optional(&pool)
    .await
    .map_err(|err| err.to_string())?
    .ok_or_else(|| "Transcription not found".to_string())?;

    let transcript: String = row.get("transcript");
    let raw_transcript: Option<String> = row.get("raw_transcript");
    let audio_path: Option<String> = row.get("audio_path");

    let short_id = if id.len() > 8 { &id[..8] } else { &id };
    let dialog = rfd::AsyncFileDialog::new()
        .set_file_name(format!("voquill-{short_id}.zip"))
        .add_filter("ZIP Archive", &["zip"])
        .save_file()
        .await;

    let save_path = match dialog {
        Some(handle) => handle.path().to_path_buf(),
        None => return Ok(false),
    };

    let audio_dir =
        crate::system::audio_store::audio_dir(&app).map_err(|err| err.to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        use zip::write::SimpleFileOptions;

        let file = std::fs::File::create(&save_path)
            .map_err(|err| format!("Failed to create file: {err}"))?;
        let mut zip = zip::ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        zip.start_file("processed.txt", options)
            .map_err(|err| err.to_string())?;
        zip.write_all(transcript.as_bytes())
            .map_err(|err| err.to_string())?;

        if let Some(ref raw) = raw_transcript {
            if !raw.is_empty() {
                zip.start_file("raw.txt", options)
                    .map_err(|err| err.to_string())?;
                zip.write_all(raw.as_bytes())
                    .map_err(|err| err.to_string())?;
            }
        }

        if let Some(ref audio_path_str) = audio_path {
            let audio_path_buf = PathBuf::from(audio_path_str);
            if audio_path_buf.starts_with(&audio_dir) && audio_path_buf.exists() {
                let audio_data = std::fs::read(&audio_path_buf)
                    .map_err(|err| format!("Failed to read audio: {err}"))?;
                zip.start_file("audio.wav", options)
                    .map_err(|err| err.to_string())?;
                zip.write_all(&audio_data)
                    .map_err(|err| err.to_string())?;
            }
        }

        zip.finish().map_err(|err| err.to_string())?;
        Ok::<bool, String>(true)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn term_create(
    term: crate::domain::Term,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<crate::domain::Term, String> {
    crate::db::term_queries::insert_term(database.pool(), &term)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn term_update(
    term: crate::domain::Term,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<crate::domain::Term, String> {
    crate::db::term_queries::update_term(database.pool(), &term)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn term_list(
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<Vec<crate::domain::Term>, String> {
    crate::db::term_queries::fetch_terms(database.pool())
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn term_delete(
    id: String,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<(), String> {
    crate::db::term_queries::delete_term(database.pool(), &id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn hotkey_list(
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<Vec<crate::domain::Hotkey>, String> {
    crate::db::hotkey_queries::fetch_hotkeys(database.pool())
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn hotkey_save(
    hotkey: crate::domain::Hotkey,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<crate::domain::Hotkey, String> {
    crate::db::hotkey_queries::upsert_hotkey(database.pool(), &hotkey)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn hotkey_delete(
    id: String,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<(), String> {
    crate::db::hotkey_queries::delete_hotkey(database.pool(), &id)
        .await
        .map_err(|err| err.to_string())
}

fn current_timestamp_millis() -> Result<i64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| err.to_string())?;

    match duration.as_millis().try_into() {
        Ok(value) => Ok(value),
        Err(_) => Ok(i64::MAX),
    }
}

#[tauri::command]
pub async fn api_key_create(
    api_key: ApiKeyCreateRequest,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<ApiKeyView, String> {
    let ApiKeyCreateRequest {
        id,
        name,
        provider,
        key,
        base_url,
        azure_region,
        include_v1_path,
    } = api_key;

    let protected = protect_api_key(&key);
    let created_at = current_timestamp_millis()?;

    let stored = ApiKey {
        id,
        name,
        provider,
        created_at,
        salt: protected.salt_b64,
        key_hash: protected.hash_b64,
        key_ciphertext: protected.ciphertext_b64,
        key_suffix: protected.key_suffix,
        transcription_model: None,
        post_processing_model: None,
        openrouter_config: None,
        base_url,
        azure_region,
        include_v1_path,
    };

    crate::db::api_key_queries::insert_api_key(database.pool(), &stored)
        .await
        .map(|saved| ApiKeyView::from(saved).with_full_key(Some(key)))
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn api_key_list(
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<Vec<ApiKeyView>, String> {
    crate::db::api_key_queries::fetch_api_keys(database.pool())
        .await
        .map(|api_keys| {
            api_keys
                .into_iter()
                .map(|api_key| {
                    let full_key = reveal_api_key(&api_key.salt, &api_key.key_ciphertext)
                        .map_err(|err| {
                            eprintln!("Failed to reveal API key {}: {}", api_key.id, err);
                            err
                        })
                        .ok();
                    ApiKeyView::from(api_key).with_full_key(full_key)
                })
                .collect()
        })
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn api_key_delete(
    id: String,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<(), String> {
    crate::db::api_key_queries::delete_api_key(database.pool(), &id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn api_key_update(
    request: crate::domain::ApiKeyUpdateRequest,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<(), String> {
    crate::db::api_key_queries::update_api_key(database.pool(), &request)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn tone_upsert(
    tone: crate::domain::Tone,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<crate::domain::Tone, String> {
    let pool = database.pool();

    if let Some(existing) = crate::db::tone_queries::fetch_tone_by_id(pool.clone(), &tone.id)
        .await
        .map_err(|err| err.to_string())?
    {
        let updated = crate::domain::Tone {
            created_at: existing.created_at,
            ..tone.clone()
        };

        crate::db::tone_queries::update_tone(pool.clone(), &updated)
            .await
            .map_err(|err| err.to_string())?;

        return Ok(updated);
    }

    let created_at = if tone.created_at > 0 {
        tone.created_at
    } else {
        current_timestamp_millis()?
    };

    let new_tone = crate::domain::Tone { created_at, ..tone };

    crate::db::tone_queries::insert_tone(pool, &new_tone)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn tone_list(
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<Vec<crate::domain::Tone>, String> {
    crate::db::tone_queries::fetch_all_tones(database.pool())
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn tone_get(
    id: String,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<Option<crate::domain::Tone>, String> {
    crate::db::tone_queries::fetch_tone_by_id(database.pool(), &id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn tone_delete(
    id: String,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<(), String> {
    crate::db::tone_queries::delete_tone(database.pool(), &id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn clear_local_data(
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<(), String> {
    let pool = database.pool();
    let mut transaction = pool.begin().await.map_err(|err| err.to_string())?;

    const TABLES_TO_CLEAR: [&str; 6] = [
        "user_profiles",
        "transcriptions",
        "terms",
        "hotkeys",
        "api_keys",
        "user_preferences",
    ];

    for table in TABLES_TO_CLEAR {
        let statement = format!("DELETE FROM {table}");
        sqlx::query(&statement)
            .execute(&mut *transaction)
            .await
            .map_err(|err| err.to_string())?;
    }

    transaction.commit().await.map_err(|err| err.to_string())?;

    if let Err(err) = sqlx::query("VACUUM").execute(&pool).await {
        eprintln!("VACUUM failed after clearing local data: {err}");
    }

    Ok(())
}

#[tauri::command]
pub fn play_audio(clip: AudioClip) -> Result<(), String> {
    match clip {
        AudioClip::StartRecordingClip => crate::system::audio_feedback::play_start_recording_clip(),
        AudioClip::StopRecordingClip => crate::system::audio_feedback::play_stop_recording_clip(),
        AudioClip::AlertLinuxClip => crate::system::audio_feedback::play_alert_linux_clip(),
        AudioClip::AlertMacosClip => crate::system::audio_feedback::play_alert_macos_clip(),
        AudioClip::AlertWindows10Clip => {
            crate::system::audio_feedback::play_alert_windows_10_clip()
        }
        AudioClip::AlertWindows11Clip => {
            crate::system::audio_feedback::play_alert_windows_11_clip()
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    recorder: State<'_, Arc<dyn crate::platform::Recorder>>,
    args: Option<StartRecordingArgs>,
) -> Result<StartRecordingResponse, String> {
    let options = args.unwrap_or_default();

    recorder.set_preferred_input_device(options.preferred_microphone.clone());

    let level_emit_handle = app.clone();
    let level_emitter: LevelCallback = Arc::new(move |levels: Vec<f32>| {
        let payload = RecordingLevelPayload { levels };
        if let Err(err) = level_emit_handle.emit_to(EventTarget::any(), EVT_REC_LEVEL, payload) {
            eprintln!("Failed to emit recording_level event: {err}");
        }
    });

    let chunk_emit_handle = app.clone();
    let chunk_emitter: ChunkCallback = Arc::new(move |samples: Vec<f32>| {
        let payload = AudioChunkPayload { samples };
        if let Err(err) = chunk_emit_handle.emit_to(EventTarget::any(), EVT_AUDIO_CHUNK, payload) {
            eprintln!("Failed to emit audio_chunk event: {err}");
        }
    });

    let recorder_clone = Arc::clone(&recorder);
    let start_result = tauri::async_runtime::spawn_blocking(move || {
        match recorder_clone.start(Some(level_emitter), Some(chunk_emitter)) {
            Ok(()) => Ok(()),
            Err(err) => {
                let already_recording = (&*err)
                    .downcast_ref::<crate::errors::RecordingError>()
                    .map(|inner| matches!(inner, crate::errors::RecordingError::AlreadyRecording))
                    .unwrap_or(false);
                Err((err.to_string(), already_recording))
            }
        }
    })
    .await
    .map_err(|err| format!("Recording task panicked: {err}"))?;

    match start_result {
        Ok(()) => {
            let reported_sample_rate = recorder.current_sample_rate().unwrap_or(16_000);
            eprintln!("[recording] start_recording succeeded with sample_rate={reported_sample_rate}");
            Ok(StartRecordingResponse {
                sample_rate: reported_sample_rate,
            })
        }
        Err((message, already_recording)) => {
            if already_recording {
                let reported_sample_rate = recorder.current_sample_rate().unwrap_or(16_000);
                eprintln!("[recording] start_recording: already recording, returning existing sample_rate={reported_sample_rate}");
                return Ok(StartRecordingResponse {
                    sample_rate: reported_sample_rate,
                });
            }

            eprintln!("[recording] Failed to start recording: {message}");
            Err(message)
        }
    }
}

#[tauri::command]
pub async fn stop_recording(
    _app: AppHandle,
    recorder: State<'_, Arc<dyn crate::platform::Recorder>>,
) -> Result<StopRecordingResponse, String> {
    let recorder = Arc::clone(&recorder);

    tauri::async_runtime::spawn_blocking(move || match recorder.stop() {
        Ok(result) => {
            let audio = result.audio;
            if audio.samples.is_empty() {
                eprintln!("[recording] warning: stopped recording with empty samples (rate={})", audio.sample_rate);
            }
            Ok(StopRecordingResponse {
                samples: audio.samples,
                sample_rate: audio.sample_rate,
            })
        }
        Err(err) => {
            let not_recording = (&*err)
                .downcast_ref::<crate::errors::RecordingError>()
                .map(|inner| matches!(inner, crate::errors::RecordingError::NotRecording))
                .unwrap_or(false);

            if not_recording {
                eprintln!("[recording] error: stop_recording called but no recording is active");
                return Err("No recording is active. Please start a recording first.".to_string());
            }

            let message = err.to_string();
            eprintln!("Failed to stop recording via command: {message}");
            Err(message)
        }
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn store_transcription_audio(
    app: AppHandle,
    id: String,
    samples: Vec<f64>,
    sample_rate: u32,
) -> Result<TranscriptionAudioSnapshot, String> {
    if sample_rate == 0 {
        return Err("Audio sample rate must be greater than zero".to_string());
    }

    let mut filtered = Vec::with_capacity(samples.len());
    for sample in samples {
        if sample.is_finite() {
            filtered.push(sample as f32);
        }
    }

    if filtered.is_empty() {
        return Err("No usable audio samples provided".to_string());
    }

    let handle = app.clone();
    let audio_id = id.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::system::audio_store::save_transcription_audio(
            &handle,
            &audio_id,
            &filtered,
            sample_rate,
        )
        .map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?;

    result
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUploadArgs {
    pub path: String,
    pub data: Vec<u8>,
}

#[tauri::command]
pub fn storage_upload_data(app: AppHandle, args: StorageUploadArgs) -> Result<(), String> {
    let repo = StorageRepo::new(&app).map_err(|err| err.to_string())?;
    repo.upload_data(&args.path, &args.data)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn storage_get_download_url(app: AppHandle, path: String) -> Result<String, String> {
    let repo = StorageRepo::new(&app).map_err(|err| err.to_string())?;
    repo.get_download_url(&path).map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn transcribe_audio(
    app: AppHandle,
    samples: Vec<f64>,
    sample_rate: u32,
    options: Option<TranscriptionOptionsDto>,
    transcriber_state: State<'_, crate::state::TranscriberState>,
) -> Result<String, String> {
    let mut request = TranscriptionRequest::default();
    let mut model_size = WhisperModelSize::default();

    if let Some(TranscriptionOptionsDto {
        device,
        model_size: maybe_model_size,
        initial_prompt,
        language: maybe_language,
    }) = options
    {
        if let Some(device_dto) = device {
            request = device_dto.into_request();
        }

        if let Some(prompt_value) = initial_prompt {
            let sanitized: String = prompt_value.chars().filter(|ch| *ch != '\0').collect();
            let trimmed = sanitized.trim();
            if !trimmed.is_empty() {
                request.initial_prompt = Some(trimmed.to_string());
            }
        }

        if let Some(language_value) = maybe_language {
            let sanitized: String = language_value.chars().filter(|ch| *ch != '\0').collect();
            let trimmed = sanitized.trim();
            if !trimmed.is_empty() {
                request.language = Some(trimmed.to_string());
            }
        }

        if let Some(size_value) = maybe_model_size {
            match size_value.parse::<WhisperModelSize>() {
                Ok(parsed) => {
                    model_size = parsed;
                }
                Err(_) => {
                    eprintln!(
                        "Unrecognised Whisper model size '{}'; falling back to default.",
                        size_value
                    );
                }
            }
        }
    }

    let initial_path = crate::system::paths::whisper_model_path(&app, model_size)
        .map_err(|err| err.to_string())?;

    let model_path = if initial_path.exists() {
        initial_path
    } else {
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::system::models::ensure_whisper_model(&handle, model_size)
                .map_err(|err| err.to_string())
        })
        .await
        .map_err(|err| err.to_string())??
    };

    let transcriber = if let Some(existing) = transcriber_state.get() {
        existing.clone()
    } else {
        eprintln!("[transcribe_audio] Transcriber not initialized, performing lazy initialization...");
        let init_model_path = model_path.clone();
        let new_transcriber: Arc<dyn crate::platform::Transcriber> = Arc::new(
            crate::platform::whisper::WhisperTranscriber::new(&init_model_path)
                .map_err(|err| format!("Failed to initialize Whisper transcriber: {err}"))?,
        );
        let _ = transcriber_state.initialize(new_transcriber.clone());
        new_transcriber
    };

    let model_path_string = model_path.to_string_lossy().into_owned();
    request.model_path = Some(model_path_string);

    let request = Some(request);
    let join_result = tauri::async_runtime::spawn_blocking(move || {
        let original_len = samples.len();
        let mut filtered = Vec::with_capacity(original_len);
        for sample in samples {
            if sample.is_finite() {
                filtered.push(sample as f32);
            }
        }

        if filtered.len() != original_len {
            eprintln!(
                "Discarded {} non-finite audio samples before transcription",
                original_len - filtered.len()
            );
        }

        if filtered.is_empty() {
            return Err("No usable audio samples provided".to_string());
        }

        let request_ref = request.as_ref();
        transcriber
            .transcribe(filtered.as_slice(), sample_rate, request_ref)
            .map(|text| text.trim().to_string())
    })
    .await;

    match join_result {
        Ok(result) => {
            if let Err(err) = result.as_ref() {
                eprintln!("Transcription failed: {err}");
            }

            result
        }
        Err(err) => {
            let message = format!("Transcription task join error: {err}");
            eprintln!("{message}");
            Err(message)
        }
    }
}

#[tauri::command]
pub async fn purge_stale_transcription_audio(
    app: AppHandle,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<Vec<String>, String> {
    let pool = database.pool();

    let rows = sqlx::query(
        "SELECT id, audio_path
         FROM transcriptions
         WHERE audio_path IS NOT NULL
         ORDER BY timestamp DESC",
    )
    .fetch_all(&pool)
    .await
    .map_err(|err| err.to_string())?;

    let stale_entries: Vec<(String, String)> = rows
        .into_iter()
        .skip(MAX_RETAINED_TRANSCRIPTION_AUDIO)
        .map(|row| {
            (
                row.get::<String, _>("id"),
                row.get::<String, _>("audio_path"),
            )
        })
        .collect();

    if stale_entries.is_empty() {
        return Ok(Vec::new());
    }

    let purged_ids = delete_audio_entries(app.clone(), stale_entries).await?;

    if purged_ids.is_empty() {
        return Ok(purged_ids);
    }

    for id in &purged_ids {
        sqlx::query(
            "UPDATE transcriptions
             SET audio_path = NULL,
                 audio_duration_ms = NULL
             WHERE id = ?1",
        )
        .bind(id)
        .execute(&pool)
        .await
        .map_err(|err| err.to_string())?;
    }

    Ok(purged_ids)
}

#[tauri::command]
pub fn surface_main_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    crate::platform::window::surface_main_window(&window)?;
    Ok(())
}

#[tauri::command]
pub fn set_toast_overlay_click_through(app: AppHandle, click_through: bool) -> Result<(), String> {
    let window = app
        .get_webview_window(crate::overlay::TOAST_OVERLAY_LABEL)
        .ok_or_else(|| "toast-overlay window not found".to_string())?;

    crate::platform::window::set_overlay_click_through(&window, click_through)
}

#[tauri::command]
pub fn set_agent_overlay_click_through(app: AppHandle, click_through: bool) -> Result<(), String> {
    let window = app
        .get_webview_window(crate::overlay::AGENT_OVERLAY_LABEL)
        .ok_or_else(|| "agent-overlay window not found".to_string())?;

    crate::platform::window::set_overlay_click_through(&window, click_through)
}

#[tauri::command]
pub fn restore_overlay_focus() {
    #[cfg(target_os = "windows")]
    {
        crate::platform::windows::window::restore_foreground_window();
    }
}

#[tauri::command]
pub async fn paste(text: String, keybind: Option<String>) -> Result<(), String> {
    let join_result =
        tauri::async_runtime::spawn_blocking(move || platform_paste_text(&text, keybind.as_deref())).await;

    match join_result {
        Ok(result) => {
            if let Err(err) = result.as_ref() {
                eprintln!("Paste failed: {err}");
            }

            result
        }
        Err(err) => {
            let message = format!("Paste task join error: {err}");
            eprintln!("{message}");
            Err(message)
        }
    }
}

#[tauri::command]
pub fn set_phase(
    app: AppHandle,
    phase: String,
    overlay_state: State<'_, crate::state::OverlayState>,
) -> Result<(), String> {
    let resolved =
        OverlayPhase::from_str(phase.as_str()).ok_or_else(|| format!("invalid phase: {phase}"))?;

    overlay_state.set_phase(&resolved);

    let payload = OverlayPhasePayload {
        phase: resolved.clone(),
    };

    app.emit_to(EventTarget::any(), EVT_OVERLAY_PHASE, payload)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn set_pill_hover_enabled(
    enabled: bool,
    overlay_state: State<'_, crate::state::OverlayState>,
) {
    overlay_state.set_pill_hover_enabled(enabled);
}

#[tauri::command]
pub fn start_key_listener(app: AppHandle) -> Result<(), String> {
    crate::platform::keyboard::start_key_listener(&app)
}

#[tauri::command]
pub fn stop_key_listener() -> Result<(), String> {
    crate::platform::keyboard::stop_key_listener()
}

#[tauri::command]
pub fn sync_hotkey_combos(combos: Vec<Vec<String>>) {
    crate::platform::keyboard::sync_combos(combos);
}

#[tauri::command]
pub fn set_tray_title(app: AppHandle, title: Option<String>) -> Result<(), String> {
    use tauri::tray::TrayIconId;
    if let Some(tray) = app.tray_by_id(&TrayIconId::new("main")) {
        let title_ref = match &title {
            Some(t) if !t.is_empty() => Some(t.as_str()),
            _ => Some(""),
        };
        tray.set_title(title_ref).map_err(|err| err.to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn set_menu_icon(
    app: AppHandle,
    variant: crate::system::tray::MenuIconVariant,
) -> Result<(), String> {
    crate::system::tray::set_menu_icon(&app, variant)
}

#[tauri::command]
pub async fn get_text_field_info() -> Result<TextFieldInfo, String> {
    Ok(tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tauri::async_runtime::spawn_blocking(
            crate::platform::accessibility::get_text_field_info,
        ),
    )
    .await
    .map_err(|_| "get_text_field_info timed out".to_string())?
    .map_err(|err| err.to_string())?)
}

#[tauri::command]
pub async fn get_screen_context() -> Result<ScreenContextInfo, String> {
    tauri::async_runtime::spawn_blocking(crate::platform::accessibility::get_screen_context)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn get_selected_text() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(crate::platform::accessibility::get_selected_text)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn initialize_local_transcriber(
    app: AppHandle,
    transcriber_state: State<'_, crate::state::TranscriberState>,
) -> Result<bool, String> {
    if transcriber_state.is_initialized() {
        return Ok(false);
    }

    eprintln!("[initialize_local_transcriber] Pre-warming Whisper transcriber...");

    let default_model_size = WhisperModelSize::default();
    let model_path = {
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::system::models::ensure_whisper_model(&handle, default_model_size)
                .map_err(|err| err.to_string())
        })
        .await
        .map_err(|err| err.to_string())??
    };

    let new_transcriber: Arc<dyn crate::platform::Transcriber> = Arc::new(
        crate::platform::whisper::WhisperTranscriber::new(&model_path)
            .map_err(|err| format!("Failed to initialize Whisper transcriber: {err}"))?,
    );

    transcriber_state.initialize(new_transcriber)?;
    eprintln!("[initialize_local_transcriber] Whisper transcriber initialized successfully");

    Ok(true)
}

#[tauri::command]
pub fn get_keyboard_language() -> Result<String, String> {
    crate::platform::keyboard_language::get_keyboard_language()
}

/// Reads `enterprise.json` from the app config directory. Returns `None` if the file does not exist.
///
/// Platform paths:
///   - macOS:  ~/Library/Application Support/com.voquill.desktop/enterprise.json
///   - Linux:  ~/.config/com.voquill.desktop/enterprise.json
///   - Windows: C:\Users\<User>\AppData\Roaming\com.voquill.desktop\enterprise.json
#[tauri::command]
pub fn read_enterprise_target(app: AppHandle) -> Result<(String, Option<String>), String> {
    let mut path = app
        .path()
        .app_config_dir()
        .map_err(|err| err.to_string())?;
    path.push("enterprise.json");
    let path_str = path.to_string_lossy().to_string();
    eprintln!("[ENTERPRISE] Reading enterprise target from {:?}", path);
    if !path.exists() {
        return Ok((path_str, None));
    }

    let bytes = std::fs::read(&path).map_err(|err| err.to_string())?;
    let content = decode_to_utf8(&bytes).map_err(|err| format!("Failed to decode enterprise.json: {err}"))?;
    Ok((path_str, Some(content)))
}

