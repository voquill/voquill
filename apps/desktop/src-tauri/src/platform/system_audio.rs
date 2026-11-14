//! System audio: what the computer plays (the other side of a call), captured
//! separately from any microphone so a meeting records it even when the user
//! wears headphones. One source per platform behind `SystemAudioSource`.

use std::sync::Arc;

/// Whether system audio is being recorded and, if not, why.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum SystemAudioState {
    /// Starting, or waiting for the user to answer the permission prompt.
    Pending,
    /// Being recorded. Silence while nothing plays is still recording.
    Recording,
    /// This OS version cannot record system audio.
    Unsupported,
    /// The user has not allowed Voquill to record system audio.
    Denied,
    /// The system audio device failed or stopped delivering audio.
    Failed,
}

impl SystemAudioState {
    pub fn code(self) -> u32 {
        match self {
            Self::Pending => 0,
            Self::Recording => 1,
            Self::Unsupported => 2,
            Self::Denied => 3,
            Self::Failed => 4,
        }
    }

    pub fn from_code(code: u32) -> Self {
        match code {
            1 => Self::Recording,
            2 => Self::Unsupported,
            3 => Self::Denied,
            4 => Self::Failed,
            _ => Self::Pending,
        }
    }
}

/// Mono audio as the device delivered it; the rate can change between chunks
/// (a new default output device, a headset switching profiles).
pub struct SystemAudioChunk {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

pub type SystemAudioChunkCallback = Arc<dyn Fn(SystemAudioChunk) + Send + Sync>;
pub type SystemAudioStateCallback = Arc<dyn Fn(SystemAudioState) + Send + Sync>;

pub trait SystemAudioSource: Send + Sync {
    /// Begins capturing without waiting for the device or the user: progress,
    /// a permission answer and failures are reported through `on_state`.
    fn start(&self, on_chunk: SystemAudioChunkCallback, on_state: SystemAudioStateCallback);
    /// Ends the capture and returns at once; teardown finishes in the
    /// background and anything it still delivers is ignored by the caller.
    fn stop(&self);
    /// The source delivers silent samples while nothing plays, so a long gap
    /// in delivery means it stalled. Sources that go quiet instead cannot
    /// tell a stall from silence.
    fn delivers_silence(&self) -> bool;
}

pub fn new_system_audio_source() -> Arc<dyn SystemAudioSource> {
    #[cfg(target_os = "macos")]
    {
        Arc::new(crate::platform::macos::system_audio::ProcessTapSource::default())
    }
    #[cfg(target_os = "windows")]
    {
        Arc::new(crate::platform::windows::system_audio::LoopbackSource::default())
    }
    #[cfg(target_os = "linux")]
    {
        Arc::new(crate::platform::linux::system_audio::MonitorSource::default())
    }
}

/// Opens the settings page where the user allows system audio recording.
pub fn open_system_audio_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        crate::platform::macos::permissions::open_system_audio_privacy_settings()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("System audio recording needs no permission on this platform".to_string())
    }
}
