use std::sync::mpsc;

use tauri::{Emitter, Manager};

use crate::domain::{OverlayPhase, PillWindowSize};
use rust_macos_pill::ipc::{InMessage, OutMessage, Phase, PillSender, Visibility};

struct MacosPill {
    sender: PillSender,
}

impl MacosPill {
    fn send(&self, msg: InMessage) {
        self.sender.send(msg);
    }
}

pub fn try_create_native_overlays(app: &tauri::AppHandle) -> bool {
    let (out_tx, out_rx) = mpsc::channel::<OutMessage>();

    // Start the pill on the main thread (Tauri setup runs on main thread)
    let sender = rust_macos_pill::start(out_tx);

    let pill = std::sync::Arc::new(MacosPill { sender });
    app.manage(pill);

    start_out_reader(app.clone(), out_rx);

    log::info!("Using native macOS pill overlay (embedded)");
    true
}

pub fn notify_phase(app: &tauri::AppHandle, phase: &OverlayPhase) {
    if let Some(pill) = app.try_state::<std::sync::Arc<MacosPill>>() {
        let phase = match phase {
            OverlayPhase::Idle => Phase::Idle,
            OverlayPhase::Recording => Phase::Recording,
            OverlayPhase::Loading => Phase::Loading,
        };
        pill.send(InMessage::Phase { phase });
    }
}

pub fn notify_audio_levels(app: &tauri::AppHandle, levels: &[f32]) {
    if let Some(pill) = app.try_state::<std::sync::Arc<MacosPill>>() {
        pill.send(InMessage::Levels {
            levels: levels.to_vec(),
        });
    }
}

pub fn notify_visibility(app: &tauri::AppHandle, visibility: &str) {
    if let Some(pill) = app.try_state::<std::sync::Arc<MacosPill>>() {
        let visibility = match visibility {
            "hidden" => Visibility::Hidden,
            "persistent" => Visibility::Persistent,
            _ => Visibility::WhileActive,
        };
        pill.send(InMessage::Visibility { visibility });
    }
}

pub fn notify_style_info(app: &tauri::AppHandle, count: u32, name: &str) {
    if let Some(pill) = app.try_state::<std::sync::Arc<MacosPill>>() {
        pill.send(InMessage::StyleInfo {
            count,
            name: name.to_string(),
        });
    }
}

pub fn notify_pill_window_size(app: &tauri::AppHandle, size: &PillWindowSize) {
    if let Some(pill) = app.try_state::<std::sync::Arc<MacosPill>>() {
        let size_str = match size {
            PillWindowSize::Dictation => "dictation",
            PillWindowSize::AssistantCompact => "assistant_compact",
            PillWindowSize::AssistantExpanded => "assistant_expanded",
            PillWindowSize::AssistantTyping => "assistant_typing",
        };
        pill.send(InMessage::WindowSize {
            size: size_str.to_string(),
        });
    }
}

pub fn notify_assistant_state(app: &tauri::AppHandle, payload: &str) {
    if let Some(pill) = app.try_state::<std::sync::Arc<MacosPill>>() {
        if let Ok(msg) = serde_json::from_str::<InMessage>(payload) {
            pill.send(msg);
        }
    }
}

fn start_out_reader(app: tauri::AppHandle, rx: mpsc::Receiver<OutMessage>) {
    std::thread::spawn(move || {
        while let Ok(msg) = rx.recv() {
            match msg {
                OutMessage::Ready => {
                    log::info!("Native macOS pill ready");
                }
                OutMessage::Click => {
                    let _ = app.emit_to("main", "on-click-dictate", ());
                }
                OutMessage::AgentTalk => {
                    let _ = app.emit_to("main", "on-click-agent-talk", ());
                }
                OutMessage::AssistantClose => {
                    let _ = app.emit_to("main", "assistant-mode-close", ());
                }
                OutMessage::EnableTypeMode => {
                    let _ = app.emit_to("main", "assistant-enable-type-mode", ());
                }
                OutMessage::CancelDictation => {
                    let _ = app.emit_to("main", "cancel-dictation", ());
                }
                OutMessage::TypedMessage { text } => {
                    let payload = serde_json::json!({ "text": text });
                    let _ = app.emit_to("main", "assistant-typed-message", payload);
                }
                OutMessage::OpenConversation { conversation_id } => {
                    let payload = serde_json::json!({ "conversationId": conversation_id });
                    let _ = app.emit_to("main", "open-pill-conversation", payload);
                    let _ = app.emit_to("main", "assistant-mode-close", ());
                }
                OutMessage::ResolvePermission {
                    permission_id,
                    status,
                    always_allow,
                } => {
                    let payload = serde_json::json!({
                        "permissionId": permission_id,
                        "status": status,
                        "alwaysAllow": always_allow,
                    });
                    let _ = app.emit_to("main", "overlay-resolve-permission", payload);
                }
                OutMessage::StyleSwitch { direction } => {
                    if direction == "forward" {
                        let _ = app.emit_to("main", "tone-switch-forward", ());
                    } else if direction == "backward" {
                        let _ = app.emit_to("main", "tone-switch-backward", ());
                    }
                }
                OutMessage::ToastAction { action } => {
                    let payload = serde_json::json!({ "action": action });
                    let _ = app.emit_to("main", "toast-action", payload);
                }
                OutMessage::Hover { .. } => {}
            }
        }
        log::info!("Native macOS pill channel closed");
    });
}
