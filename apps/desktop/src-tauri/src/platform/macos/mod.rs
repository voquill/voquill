pub mod accessibility;
pub mod compositor;
pub mod dock;
pub mod init;
pub mod input;
pub mod keyboard;
pub mod keyboard_language;
pub mod monitor;
pub mod overlay;
pub mod permissions;
pub mod position;
pub mod screen_capture;
pub mod volume;
pub mod window;

pub fn get_hotkey_strategy() -> &'static str {
    "listener"
}

pub fn supports_app_detection() -> bool {
    true
}

pub fn supports_paste_keybinds() -> crate::platform::PasteKeybindSupport {
    crate::platform::PasteKeybindSupport::Disabled
}
