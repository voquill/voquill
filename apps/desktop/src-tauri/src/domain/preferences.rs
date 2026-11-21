use serde::{Deserialize, Serialize};

pub const DEFAULT_DICTATION_LIMIT_MINUTES: i64 = 10;

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UserPreferences {
    pub user_id: String,
    #[serde(default)]
    pub transcription_mode: Option<String>,
    #[serde(default)]
    pub transcription_api_key_id: Option<String>,
    #[serde(default)]
    pub transcription_device: Option<String>,
    #[serde(default)]
    pub transcription_model_size: Option<String>,
    #[serde(default)]
    pub post_processing_mode: Option<String>,
    #[serde(default)]
    pub post_processing_api_key_id: Option<String>,
    #[serde(default)]
    pub post_processing_ollama_url: Option<String>,
    #[serde(default)]
    pub post_processing_ollama_model: Option<String>,
    #[serde(default)]
    pub agent_mode: Option<String>,
    #[serde(default)]
    pub agent_mode_api_key_id: Option<String>,
    #[serde(default)]
    pub openclaw_gateway_url: Option<String>,
    #[serde(default)]
    pub openclaw_token: Option<String>,
    #[serde(default)]
    pub active_tone_id: Option<String>,
    #[serde(default)]
    pub got_started_at: Option<i64>,
    #[serde(default)]
    pub gpu_enumeration_enabled: bool,
    #[serde(default)]
    pub paste_keybind: Option<String>,
    #[serde(default)]
    pub last_seen_feature: Option<String>,
    #[serde(default)]
    pub is_enterprise: bool,
    #[serde(default)]
    pub language_switch_enabled: bool,
    #[serde(default)]
    pub secondary_dictation_language: Option<String>,
    #[serde(default)]
    pub active_dictation_language: Option<String>,
    #[serde(default)]
    pub additional_dictation_languages: Option<Vec<String>>,
    #[serde(default)]
    pub preferred_microphone: Option<String>,
    #[serde(default)]
    pub ignore_update_dialog: bool,
    #[serde(default)]
    pub incognito_mode_enabled: bool,
    #[serde(default)]
    pub incognito_mode_include_in_stats: bool,
    #[serde(default = "default_dictation_limit_minutes")]
    pub dictation_limit_minutes: i64,
    #[serde(default = "default_dictation_pill_visibility")]
    pub dictation_pill_visibility: String,
    #[serde(default)]
    pub use_new_backend: bool,
    #[serde(default)]
    pub realtime_output_enabled: bool,
    #[serde(default)]
    pub remote_output_enabled: bool,
    #[serde(default)]
    pub remote_target_device_id: Option<String>,
    #[serde(default)]
    pub remote_receiver_port: Option<i64>,
    #[serde(default)]
    pub remote_receiver_auto_start: bool,
    #[serde(default = "default_dictation_audio_dim")]
    pub dictation_audio_dim: f64,
    #[serde(default)]
    pub menu_bar_icon_hidden: bool,
    #[serde(default)]
    pub insertion_method: Option<String>,
    #[serde(default)]
    pub typing_speed_ms: Option<i64>,
}

fn default_dictation_pill_visibility() -> String {
    "while_active".to_string()
}

fn default_dictation_limit_minutes() -> i64 {
    DEFAULT_DICTATION_LIMIT_MINUTES
}

fn default_dictation_audio_dim() -> f64 {
    1.0
}
