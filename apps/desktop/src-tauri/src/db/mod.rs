pub mod api_key_queries;
pub mod app_target_queries;
pub mod chat_message_queries;
pub mod conversation_queries;
pub mod hotkey_queries;
pub mod paired_remote_device_queries;
pub mod preferences_queries;
pub mod term_queries;
pub mod tone_queries;
pub mod transcription_queries;
pub mod user_queries;

pub const DB_FILENAME: &str = "voquill.db";
pub const DB_CONNECTION: &str = "sqlite:voquill.db";

pub const SCHEMA_SQL: &str = include_str!("migrations/000_schema.sql");
pub const USER_PROFILES_MIGRATION_SQL: &str = include_str!("migrations/001_user_profiles.sql");
pub const TRANSCRIPTIONS_MIGRATION_SQL: &str = include_str!("migrations/002_transcriptions.sql");
pub const TERMS_MIGRATION_SQL: &str = include_str!("migrations/003_terms.sql");
pub const HOTKEYS_MIGRATION_SQL: &str = include_str!("migrations/004_hotkeys.sql");
pub const DROP_USERS_MIGRATION_SQL: &str = include_str!("migrations/005_drop_users.sql");
pub const USER_PREFERRED_MICROPHONE_MIGRATION_SQL: &str =
    include_str!("migrations/006_user_preferred_microphone.sql");
pub const USER_PLAY_INTERACTION_CHIME_MIGRATION_SQL: &str =
    include_str!("migrations/007_user_interaction_chime.sql");
pub const TRANSCRIPTION_AUDIO_MIGRATION_SQL: &str =
    include_str!("migrations/008_transcription_audio.sql");
pub const API_KEYS_MIGRATION_SQL: &str = include_str!("migrations/009_api_keys.sql");
pub const USER_AI_PREFERENCES_MIGRATION_SQL: &str =
    include_str!("migrations/010_user_ai_preferences.sql");
pub const TRANSCRIPTION_INFERENCE_METADATA_MIGRATION_SQL: &str =
    include_str!("migrations/011_transcription_inference_metadata.sql");
pub const TERMS_IS_REPLACEMENT_MIGRATION_SQL: &str =
    include_str!("migrations/012_terms_is_replacement.sql");
pub const TRANSCRIPTION_PROCESSING_METADATA_MIGRATION_SQL: &str =
    include_str!("migrations/013_transcription_processing_metadata.sql");
pub const USER_WORD_STATS_MIGRATION_SQL: &str = include_str!("migrations/014_user_word_stats.sql");
pub const USER_PREFERENCES_MIGRATION_SQL: &str =
    include_str!("migrations/015_user_preferences.sql");
pub const TRANSCRIPTION_WARNINGS_MIGRATION_SQL: &str =
    include_str!("migrations/016_transcription_warnings.sql");
pub const USER_PREFERRED_LANGUAGE_MIGRATION_SQL: &str =
    include_str!("migrations/017_user_preferred_language.sql");
pub const TONES_MIGRATION_SQL: &str = include_str!("migrations/018_tones.sql");
pub const APP_TARGETS_MIGRATION_SQL: &str = include_str!("migrations/019_app_targets.sql");
pub const APP_TARGET_TONE_ID_MIGRATION_SQL: &str =
    include_str!("migrations/020_app_target_tone_id.sql");
pub const APP_TARGET_ICON_PATH_MIGRATION_SQL: &str =
    include_str!("migrations/023_app_target_icon_path.sql");
pub const USER_PREFERENCES_INITIAL_TONES_MIGRATION_SQL: &str =
    include_str!("migrations/022_user_preferences_initial_tones.sql");
pub const CLEANUP_DEFAULT_TONES_MIGRATION_SQL: &str =
    include_str!("migrations/024_cleanup_default_tones.sql");
pub const USER_PREFERENCES_DEVICE_MIGRATION_SQL: &str =
    include_str!("migrations/025_user_preferences_device.sql");
pub const API_KEY_MODEL_MIGRATION_SQL: &str = include_str!("migrations/026_api_key_model.sql");
pub const USER_PREFERENCES_OLLAMA_MIGRATION_SQL: &str =
    include_str!("migrations/027_user_preferences_ollama.sql");
pub const USER_HAS_FINISHED_TUTORIAL_MIGRATION_SQL: &str =
    include_str!("migrations/028_user_has_finished_tutorial.sql");
pub const USER_PREFERENCES_GOT_STARTED_AT_MIGRATION_SQL: &str =
    include_str!("migrations/029_user_preferences_got_started_at.sql");
pub const GPU_ENUMERATION_ENABLED_MIGRATION_SQL: &str =
    include_str!("migrations/030_gpu_enumeration_enabled.sql");
pub const PASTE_KEYBIND_MIGRATION_SQL: &str = include_str!("migrations/031_paste_keybind.sql");
pub const APP_TARGET_PASTE_KEYBIND_MIGRATION_SQL: &str =
    include_str!("migrations/032_app_target_paste_keybind.sql");
pub const TRANSCRIPTION_TIMING_METRICS_MIGRATION_SQL: &str =
    include_str!("migrations/033_transcription_timing_metrics.sql");
pub const API_KEY_OPENROUTER_CONFIG_MIGRATION_SQL: &str =
    include_str!("migrations/034_api_key_openrouter_config.sql");
pub const API_KEY_BASE_URL_MIGRATION_SQL: &str =
    include_str!("migrations/035_api_key_base_url.sql");
pub const API_KEY_AZURE_REGION_MIGRATION_SQL: &str =
    include_str!("migrations/036_api_key_azure_region.sql");
pub const AGENT_MODE_MIGRATION_SQL: &str = include_str!("migrations/037_agent_mode.sql");
pub const LAST_SEEN_FEATURE_MIGRATION_SQL: &str =
    include_str!("migrations/038_last_seen_feature.sql");
pub const IS_ENTERPRISE_MIGRATION_SQL: &str = include_str!("migrations/039_is_enterprise.sql");
pub const LANGUAGE_SWITCH_MIGRATION_SQL: &str = include_str!("migrations/040_language_switch.sql");
pub const MICROPHONE_TO_PREFERENCES_MIGRATION_SQL: &str =
    include_str!("migrations/041_microphone_to_preferences.sql");
pub const USER_COHORT_MIGRATION_SQL: &str = include_str!("migrations/042_user_cohort.sql");
pub const IGNORE_UPDATE_DIALOG_MIGRATION_SQL: &str =
    include_str!("migrations/043_ignore_update_dialog.sql");
pub const USER_COMPANY_TITLE_MIGRATION_SQL: &str =
    include_str!("migrations/044_user_company_title.sql");
pub const INCOGNITO_MODE_MIGRATION_SQL: &str = include_str!("migrations/045_incognito_mode.sql");
pub const DICTATION_PILL_VISIBILITY_MIGRATION_SQL: &str =
    include_str!("migrations/046_dictation_pill_visibility.sql");
pub const TRANSCRIPTION_SANITIZED_TRANSCRIPT_MIGRATION_SQL: &str =
    include_str!("migrations/047_transcription_sanitized_transcript.sql");
pub const USER_STYLING_MODE_MIGRATION_SQL: &str =
    include_str!("migrations/048_user_styling_mode.sql");
pub const USER_SELECTED_TONE_ID_MIGRATION_SQL: &str =
    include_str!("migrations/049_user_selected_tone_id.sql");
pub const USER_ACTIVE_TONE_IDS_MIGRATION_SQL: &str =
    include_str!("migrations/050_user_active_tone_ids.sql");
pub const ADDITIONAL_DICTATION_LANGUAGES_MIGRATION_SQL: &str =
    include_str!("migrations/051_additional_dictation_languages.sql");
pub const USE_NEW_BACKEND_MIGRATION_SQL: &str = include_str!("migrations/052_use_new_backend.sql");
pub const OPENCLAW_PREFERENCES_MIGRATION_SQL: &str =
    include_str!("migrations/053_openclaw_preferences.sql");
pub const USER_STREAK_MIGRATION_SQL: &str = include_str!("migrations/054_user_streak.sql");
pub const USER_REFERRAL_SOURCE_MIGRATION_SQL: &str =
    include_str!("migrations/055_user_referral_source.sql");
pub const API_KEY_INCLUDE_V1_PATH_MIGRATION_SQL: &str =
    include_str!("migrations/056_api_key_include_v1_path.sql");
pub const REALTIME_OUTPUT_MIGRATION_SQL: &str = include_str!("migrations/057_realtime_output.sql");
pub const REMOTE_OUTPUT_AND_DEVICES_MIGRATION_SQL: &str =
    include_str!("migrations/058_remote_output_and_devices.sql");
pub const REMOTE_OUTPUT_AND_DEVICES_COMPAT_MIGRATION_SQL: &str =
    include_str!("migrations/059_remote_output_and_devices.sql");
pub const REMOTE_RECEIVER_PORT_MIGRATION_SQL: &str =
    include_str!("migrations/060_remote_receiver_port.sql");
pub const REMOTE_RECEIVER_AUTO_START_MIGRATION_SQL: &str =
    include_str!("migrations/061_remote_receiver_auto_start.sql");
pub const TRANSCRIPTION_REMOTE_STATUS_MIGRATION_SQL: &str =
    include_str!("migrations/062_transcription_remote_status.sql");
pub const CONVERSATIONS_AND_CHAT_MESSAGES_MIGRATION_SQL: &str =
    include_str!("migrations/063_conversations_and_chat_messages.sql");
pub const DICTATION_AUDIO_DIM_MIGRATION_SQL: &str =
    include_str!("migrations/064_dictation_audio_dim.sql");
pub const DICTATION_LIMIT_MINUTES_MIGRATION_SQL: &str =
    include_str!("migrations/065_dictation_limit_minutes.sql");
pub const MENU_BAR_ICON_HIDDEN_MIGRATION_SQL: &str =
    include_str!("migrations/066_menu_bar_icon_hidden.sql");
pub const TRANSCRIPTION_CONTRACT_MIGRATION_SQL: &str =
    include_str!("migrations/067_transcription_contract.sql");

pub fn migrations() -> Vec<tauri_plugin_sql::Migration> {
    vec![
        tauri_plugin_sql::Migration {
            version: 1,
            description: "create_users_table",
            sql: SCHEMA_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 2,
            description: "create_user_profiles_table",
            sql: USER_PROFILES_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 3,
            description: "create_transcriptions_table",
            sql: TRANSCRIPTIONS_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 4,
            description: "create_terms_table",
            sql: TERMS_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 5,
            description: "create_hotkeys_table",
            sql: HOTKEYS_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 6,
            description: "drop_users_table",
            sql: DROP_USERS_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 7,
            description: "add_user_preferred_microphone",
            sql: USER_PREFERRED_MICROPHONE_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 8,
            description: "add_user_play_interaction_chime",
            sql: USER_PLAY_INTERACTION_CHIME_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 9,
            description: "add_transcription_audio_columns",
            sql: TRANSCRIPTION_AUDIO_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 10,
            description: "create_api_keys_table",
            sql: API_KEYS_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 11,
            description: "add_user_ai_preferences",
            sql: USER_AI_PREFERENCES_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 12,
            description: "add_transcription_inference_metadata",
            sql: TRANSCRIPTION_INFERENCE_METADATA_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 13,
            description: "add_terms_is_replacement",
            sql: TERMS_IS_REPLACEMENT_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 14,
            description: "add_transcription_processing_metadata",
            sql: TRANSCRIPTION_PROCESSING_METADATA_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 15,
            description: "add_user_word_stats",
            sql: USER_WORD_STATS_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 16,
            description: "create_user_preferences",
            sql: USER_PREFERENCES_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 17,
            description: "add_transcription_warnings",
            sql: TRANSCRIPTION_WARNINGS_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 18,
            description: "add_user_preferred_language",
            sql: USER_PREFERRED_LANGUAGE_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 19,
            description: "create_tones_table",
            sql: TONES_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 20,
            description: "create_app_targets_table",
            sql: APP_TARGETS_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 21,
            description: "add_app_target_tone_id",
            sql: APP_TARGET_TONE_ID_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 22,
            description: "add_initial_tones_flag",
            sql: USER_PREFERENCES_INITIAL_TONES_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 23,
            description: "add_app_target_icon_path",
            sql: APP_TARGET_ICON_PATH_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 24,
            description: "cleanup_default_tones",
            sql: CLEANUP_DEFAULT_TONES_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 25,
            description: "add_user_preferences_device",
            sql: USER_PREFERENCES_DEVICE_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 26,
            description: "add_api_key_model",
            sql: API_KEY_MODEL_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 27,
            description: "add_user_preferences_ollama",
            sql: USER_PREFERENCES_OLLAMA_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 28,
            description: "add_user_has_finished_tutorial",
            sql: USER_HAS_FINISHED_TUTORIAL_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 29,
            description: "add_user_preferences_got_started_at",
            sql: USER_PREFERENCES_GOT_STARTED_AT_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 30,
            description: "add_gpu_enumeration_enabled",
            sql: GPU_ENUMERATION_ENABLED_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 31,
            description: "add_paste_keybind",
            sql: PASTE_KEYBIND_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 32,
            description: "add_app_target_paste_keybind",
            sql: APP_TARGET_PASTE_KEYBIND_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 33,
            description: "add_transcription_timing_metrics",
            sql: TRANSCRIPTION_TIMING_METRICS_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 34,
            description: "add_api_key_openrouter_config",
            sql: API_KEY_OPENROUTER_CONFIG_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 35,
            description: "add_api_key_base_url",
            sql: API_KEY_BASE_URL_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 36,
            description: "add_api_key_azure_region",
            sql: API_KEY_AZURE_REGION_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 37,
            description: "add_agent_mode",
            sql: AGENT_MODE_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 38,
            description: "add_last_seen_feature",
            sql: LAST_SEEN_FEATURE_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 39,
            description: "add_is_enterprise",
            sql: IS_ENTERPRISE_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 40,
            description: "add_language_switch",
            sql: LANGUAGE_SWITCH_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 41,
            description: "move_microphone_to_preferences",
            sql: MICROPHONE_TO_PREFERENCES_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 42,
            description: "add_user_cohort",
            sql: USER_COHORT_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 43,
            description: "add_ignore_update_dialog",
            sql: IGNORE_UPDATE_DIALOG_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 44,
            description: "add_user_company_title",
            sql: USER_COMPANY_TITLE_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 45,
            description: "add_incognito_mode",
            sql: INCOGNITO_MODE_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 46,
            description: "add_dictation_pill_visibility",
            sql: DICTATION_PILL_VISIBILITY_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 47,
            description: "add_transcription_sanitized_transcript",
            sql: TRANSCRIPTION_SANITIZED_TRANSCRIPT_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 48,
            description: "add_user_styling_mode",
            sql: USER_STYLING_MODE_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 49,
            description: "add_user_selected_tone_id",
            sql: USER_SELECTED_TONE_ID_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 50,
            description: "add_user_active_tone_ids",
            sql: USER_ACTIVE_TONE_IDS_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 51,
            description: "add_additional_dictation_languages",
            sql: ADDITIONAL_DICTATION_LANGUAGES_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 52,
            description: "add_use_new_backend",
            sql: USE_NEW_BACKEND_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 53,
            description: "add_openclaw_preferences",
            sql: OPENCLAW_PREFERENCES_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 54,
            description: "add_user_streak",
            sql: USER_STREAK_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 55,
            description: "add_user_referral_source",
            sql: USER_REFERRAL_SOURCE_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 56,
            description: "add_api_key_include_v1_path",
            sql: API_KEY_INCLUDE_V1_PATH_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 57,
            description: "add_realtime_output",
            sql: REALTIME_OUTPUT_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 58,
            description: "add_remote_output_and_paired_devices",
            sql: REMOTE_OUTPUT_AND_DEVICES_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 59,
            description: "remote_output_and_devices_compatibility_noop",
            sql: REMOTE_OUTPUT_AND_DEVICES_COMPAT_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 60,
            description: "add_remote_receiver_port",
            sql: REMOTE_RECEIVER_PORT_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 61,
            description: "add_remote_receiver_auto_start",
            sql: REMOTE_RECEIVER_AUTO_START_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 62,
            description: "add_transcription_remote_status",
            sql: TRANSCRIPTION_REMOTE_STATUS_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 63,
            description: "create_conversations_and_chat_messages_tables",
            sql: CONVERSATIONS_AND_CHAT_MESSAGES_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 64,
            description: "add_dictation_audio_dim",
            sql: DICTATION_AUDIO_DIM_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 65,
            description: "add_dictation_limit_minutes",
            sql: DICTATION_LIMIT_MINUTES_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 66,
            description: "add_menu_bar_icon_hidden",
            sql: MENU_BAR_ICON_HIDDEN_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 67,
            description: "add_transcription_contract_fields",
            sql: TRANSCRIPTION_CONTRACT_MIGRATION_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
    ]
}
