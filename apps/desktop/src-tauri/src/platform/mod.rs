use std::sync::Arc;

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum NativeSetupResult {
    Success,
    RequireRestart,
    Failed,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum NativeSetupStatus {
    Ready,
    NeedsSetup,
    NeedsRestart,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum PasteKeybindSupport {
    Disabled,
    PerApp,
    Global,
}

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "linux")]
pub use linux::accessibility;
#[cfg(target_os = "linux")]
pub use linux::input;
#[cfg(target_os = "linux")]
pub use linux::monitor;
#[cfg(target_os = "linux")]
pub use linux::permissions;
#[cfg(target_os = "linux")]
pub use linux::position;
#[cfg(target_os = "linux")]
pub use linux::window;

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "macos")]
pub use macos::accessibility;
#[cfg(target_os = "macos")]
pub use macos::input;
#[cfg(target_os = "macos")]
pub use macos::monitor;
#[cfg(target_os = "macos")]
pub use macos::permissions;
#[cfg(target_os = "macos")]
pub use macos::position;
#[cfg(target_os = "macos")]
pub use macos::window;

#[cfg(target_os = "windows")]
pub mod windows;
#[cfg(target_os = "windows")]
pub use windows::accessibility;
#[cfg(target_os = "windows")]
pub use windows::input;
#[cfg(target_os = "windows")]
pub use windows::monitor;
#[cfg(target_os = "windows")]
pub use windows::permissions;
#[cfg(target_os = "windows")]
pub use windows::position;
#[cfg(target_os = "windows")]
pub use windows::window;

#[cfg(target_os = "linux")]
pub use linux::compositor;
#[cfg(target_os = "linux")]
pub use linux::init;
#[cfg(target_os = "linux")]
pub use linux::keyboard_language;
#[cfg(target_os = "macos")]
pub use macos::compositor;
#[cfg(target_os = "macos")]
pub use macos::init;
#[cfg(target_os = "macos")]
pub use macos::keyboard_language;
#[cfg(target_os = "windows")]
pub use windows::compositor;
#[cfg(target_os = "windows")]
pub use windows::init;
#[cfg(target_os = "windows")]
pub use windows::keyboard_language;

#[cfg(target_os = "linux")]
pub use linux::get_hotkey_strategy;
#[cfg(target_os = "macos")]
pub use macos::get_hotkey_strategy;
#[cfg(target_os = "windows")]
pub use windows::get_hotkey_strategy;

#[cfg(target_os = "linux")]
pub use linux::supports_app_detection;
#[cfg(target_os = "macos")]
pub use macos::supports_app_detection;
#[cfg(target_os = "windows")]
pub use windows::supports_app_detection;

#[cfg(target_os = "linux")]
pub use linux::supports_paste_keybinds;
#[cfg(target_os = "macos")]
pub use macos::supports_paste_keybinds;
#[cfg(target_os = "windows")]
pub use windows::supports_paste_keybinds;

#[cfg(target_os = "linux")]
pub use linux::overlay;
#[cfg(target_os = "macos")]
pub use macos::overlay;
#[cfg(target_os = "windows")]
pub use windows::overlay;

#[cfg(target_os = "linux")]
pub use linux::volume;
#[cfg(target_os = "macos")]
pub use macos::volume;
#[cfg(target_os = "windows")]
pub use windows::volume;

pub fn find_pid_by_window_title(title_substring: &str) -> Option<i32> {
    #[cfg(target_os = "windows")]
    {
        windows::window::find_pid_by_window_title(title_substring)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = title_substring;
        None
    }
}

pub mod app_info;

pub mod audio;

pub mod paste_keybind;

#[cfg(desktop)]
pub mod keyboard;

pub enum SavedClipboard {
    Text(String),
    Image(arboard::ImageData<'static>),
    Empty,
}

impl SavedClipboard {
    pub fn save(clipboard: &mut arboard::Clipboard) -> Self {
        if let Ok(text) = clipboard.get_text() {
            return Self::Text(text);
        }
        if let Ok(image) = clipboard.get_image() {
            return Self::Image(image);
        }
        Self::Empty
    }

    /// Restores the saved contents only if the clipboard still holds `pasted`,
    /// so text copied after the paste (by the app or the user) is not clobbered.
    pub fn restore_unless_replaced(self, pasted: &str) {
        if clipboard_holds_text(pasted) {
            self.restore();
        }
    }

    pub fn restore(self) {
        if let Ok(mut cb) = arboard::Clipboard::new() {
            match self {
                Self::Text(text) => {
                    let _ = cb.set_text(text);
                }
                Self::Image(image) => {
                    let _ = cb.set_image(image);
                }
                Self::Empty => {}
            }
        }
    }
}

pub fn clipboard_holds_text(expected: &str) -> bool {
    arboard::Clipboard::new()
        .and_then(|mut clipboard| clipboard.get_text())
        .map(|current| current == expected)
        .unwrap_or(false)
}

pub type LevelCallback = Arc<dyn Fn(Vec<f32>) + Send + Sync>;
pub type ChunkCallback = Arc<dyn Fn(Vec<f32>) + Send + Sync>;

pub trait Recorder: Send + Sync {
    fn start(
        &self,
        level_callback: Option<LevelCallback>,
        chunk_callback: Option<ChunkCallback>,
    ) -> Result<(), Box<dyn std::error::Error>>;
    fn stop(&self) -> Result<crate::domain::RecordingResult, Box<dyn std::error::Error>>;
    fn set_preferred_input_device(&self, _name: Option<String>) {}
    fn clear_device_cache(&self) {}
    fn current_sample_rate(&self) -> Option<u32> {
        None
    }
}
