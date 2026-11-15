use std::io::{BufRead, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

use crate::domain::{OverlayPhase, PillWindowSize};

pub struct PillProcess {
    _child: Child,
    stdin: Mutex<ChildStdin>,
}

impl PillProcess {
    pub fn send(&self, msg: &str) {
        if let Ok(mut stdin) = self.stdin.lock() {
            if let Err(e) = stdin
                .write_all(msg.as_bytes())
                .and_then(|_| stdin.write_all(b"\n"))
                .and_then(|_| stdin.flush())
            {
                log::warn!("Failed to write to pill process: {e}");
            }
        }
    }
}

pub fn try_spawn_pill(app: &tauri::AppHandle, pill_path: &std::path::Path) -> bool {
    let spawn_time = Instant::now();
    log::info!("Spawning pill overlay from: {}", pill_path.display());

    let mut command = Command::new(pill_path);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            log::warn!("Failed to spawn pill overlay: {err}");
            return false;
        }
    };

    let stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            log::warn!("Pill overlay process has no stdin");
            return false;
        }
    };

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            log::warn!("Pill overlay process has no stdout");
            return false;
        }
    };

    let reader = match wait_for_ready(stdout, &mut child) {
        Some(reader) => reader,
        None => {
            let _ = child.kill();
            return false;
        }
    };

    let process = std::sync::Arc::new(PillProcess {
        _child: child,
        stdin: Mutex::new(stdin),
    });

    app.manage(process);

    start_stdout_reader(app.clone(), reader);

    log::info!(
        "Native pill overlay is active (initialized in {:.1}s)",
        spawn_time.elapsed().as_secs_f64()
    );
    true
}

pub fn notify_phase(app: &tauri::AppHandle, phase: &OverlayPhase) {
    if let Some(pill) = app.try_state::<std::sync::Arc<PillProcess>>() {
        let phase_str = match phase {
            OverlayPhase::Idle => "idle",
            OverlayPhase::Recording => "recording",
            OverlayPhase::Loading => "loading",
        };
        pill.send(&format!(r#"{{"type":"phase","phase":"{phase_str}"}}"#));
    }
}

pub fn notify_audio_levels(app: &tauri::AppHandle, levels: &[f32]) {
    if let Some(pill) = app.try_state::<std::sync::Arc<PillProcess>>() {
        if let Ok(json) =
            serde_json::to_string(&serde_json::json!({"type": "levels", "levels": levels}))
        {
            pill.send(&json);
        }
    }
}

pub fn notify_visibility(app: &tauri::AppHandle, visibility: &str) {
    if let Some(pill) = app.try_state::<std::sync::Arc<PillProcess>>() {
        pill.send(&format!(
            r#"{{"type":"visibility","visibility":"{visibility}"}}"#
        ));
    }
}

pub fn notify_style_info(app: &tauri::AppHandle, count: u32, name: &str) {
    if let Some(pill) = app.try_state::<std::sync::Arc<PillProcess>>() {
        if let Ok(json) = serde_json::to_string(&serde_json::json!({
            "type": "style_info",
            "count": count,
            "name": name,
        })) {
            pill.send(&json);
        }
    }
}

pub fn notify_pill_window_size(app: &tauri::AppHandle, size: &PillWindowSize) {
    if let Some(pill) = app.try_state::<std::sync::Arc<PillProcess>>() {
        let size_str = match size {
            PillWindowSize::Dictation => "dictation",
            PillWindowSize::AssistantCompact => "assistant_compact",
            PillWindowSize::AssistantExpanded => "assistant_expanded",
            PillWindowSize::AssistantTyping => "assistant_typing",
        };
        pill.send(&format!(r#"{{"type":"window_size","size":"{size_str}"}}"#));
    }
}

pub fn notify_assistant_state(app: &tauri::AppHandle, payload: &str) {
    if let Some(pill) = app.try_state::<std::sync::Arc<PillProcess>>() {
        pill.send(payload);
    }
}

pub fn resolve_pill_binary_in_resources(
    app: &tauri::AppHandle,
    binary_name: &str,
) -> Option<std::path::PathBuf> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let path = resource_dir.join("resources").join(binary_name);
        if path.exists() {
            return Some(path);
        }
    }
    None
}

pub fn resolve_pill_binary_in_dev(
    package_dir_name: &str,
    binary_name: &str,
) -> Option<std::path::PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let mut dir = exe.parent();
    while let Some(d) = dir {
        let dev_path = d
            .join("packages")
            .join(package_dir_name)
            .join("target/debug")
            .join(binary_name);
        if dev_path.exists() {
            return Some(dev_path);
        }
        dir = d.parent();
    }
    None
}

fn wait_for_ready(
    stdout: ChildStdout,
    child: &mut Child,
) -> Option<std::io::BufReader<ChildStdout>> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => {
                    let _ = tx.send(None);
                    return;
                }
                Ok(_) => {
                    if line.contains("\"ready\"") {
                        let _ = tx.send(Some(reader));
                        return;
                    }
                }
            }
        }
    });

    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(result) => return result,
            Err(RecvTimeoutError::Disconnected) => {
                log::warn!("Pill overlay reader thread died");
                return None;
            }
            Err(RecvTimeoutError::Timeout) => {
                if let Ok(Some(status)) = child.try_wait() {
                    log::warn!("Pill overlay exited before ready (status: {status})");
                    return None;
                }
                if Instant::now() >= deadline {
                    log::warn!("Pill overlay did not report ready (timed out after 30s)");
                    return None;
                }
            }
        }
    }
}

fn start_stdout_reader(app: tauri::AppHandle, reader: std::io::BufReader<ChildStdout>) {
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if line.contains("\"click\"") {
                        let _ = app.emit_to("main", "on-click-dictate", ());
                    } else if line.contains("\"agent_talk\"") {
                        let _ = app.emit_to("main", "on-click-agent-talk", ());
                    } else if line.contains("\"assistant_close\"") {
                        let _ = app.emit_to("main", "assistant-mode-close", ());
                    } else if line.contains("\"enable_type_mode\"") {
                        let _ = app.emit_to("main", "assistant-enable-type-mode", ());
                    } else if line.contains("\"cancel_dictation\"") {
                        let _ = app.emit_to("main", "cancel-dictation", ());
                    } else if line.contains("\"typed_message\"") {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                            if let Some(text) = val.get("text").and_then(|v| v.as_str()) {
                                let payload = serde_json::json!({ "text": text });
                                let _ = app.emit_to("main", "assistant-typed-message", payload);
                            }
                        }
                    } else if line.contains("\"resolve_permission\"") {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                            let permission_id = val
                                .get("permission_id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            let status = val
                                .get("status")
                                .and_then(|v| v.as_str())
                                .unwrap_or("denied");
                            let always_allow = val
                                .get("always_allow")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);
                            let payload = serde_json::json!({
                                "permissionId": permission_id,
                                "status": status,
                                "alwaysAllow": always_allow,
                            });
                            let _ = app.emit_to("main", "overlay-resolve-permission", payload);
                        }
                    } else if line.contains("\"style_switch\"") {
                        if line.contains("\"forward\"") {
                            let _ = app.emit_to("main", "tone-switch-forward", ());
                        } else if line.contains("\"backward\"") {
                            let _ = app.emit_to("main", "tone-switch-backward", ());
                        }
                    } else if line.contains("\"toast_action\"") {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                            if let Some(action) = val.get("action").and_then(|v| v.as_str()) {
                                let payload = serde_json::json!({ "action": action });
                                let _ = app.emit_to("main", "toast-action", payload);
                            }
                        }
                    }
                }
            }
        }
        log::info!("Pill overlay process stdout closed");
    });
}
