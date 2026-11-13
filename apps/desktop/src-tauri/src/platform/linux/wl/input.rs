use crate::platform::paste_keybind::{parse_paste_keystroke, PasteKeystroke};
use std::process::Command;
use std::sync::Mutex;
use std::{thread, time::Duration};

static CLIPBOARD_HOLD: Mutex<Option<arboard::Clipboard>> = Mutex::new(None);

pub(crate) fn clipboard_get() -> Result<String, String> {
    arboard::Clipboard::new()
        .and_then(|mut cb| cb.get_text())
        .map_err(|err| format!("clipboard get failed: {err}"))
}

pub(crate) fn clipboard_set(text: &str) -> Result<(), String> {
    let mut cb =
        arboard::Clipboard::new().map_err(|err| format!("clipboard create failed: {err}"))?;
    cb.set_text(text.to_string())
        .map_err(|err| format!("clipboard set failed: {err}"))?;
    let mut guard = CLIPBOARD_HOLD.lock().unwrap_or_else(|p| p.into_inner());
    *guard = Some(cb);
    Ok(())
}

// --- ydotool (works on all Wayland compositors via /dev/uinput) ---
//
// v0.1.x: key combos as "modifier+key" (e.g. "ctrl+v")
// v1.x:   scancode pairs as "code:1" (press) / "code:0" (release)
//         KEY_LEFTCTRL = 29, KEY_LEFTSHIFT = 42, KEY_C = 46, KEY_V = 47, KEY_INSERT = 110

use std::sync::OnceLock;

fn ydotool_available() -> bool {
    Command::new("ydotool")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok()
}

fn is_ydotool_v1() -> bool {
    static CACHED: OnceLock<bool> = OnceLock::new();
    *CACHED.get_or_init(|| {
        Command::new("ydotool")
            .args(["key", "--help"])
            .output()
            .map(|out| {
                let combined = format!(
                    "{}{}",
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr)
                );
                combined.contains("keycode") || combined.contains("--key-down")
            })
            .unwrap_or(false)
    })
}

fn ydotool_key(args: &[&str]) -> Result<(), String> {
    let output = Command::new("ydotool")
        .arg("key")
        .args(args)
        .output()
        .map_err(|err| format!("ydotool failed: {err}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("ydotool exited with non-zero status: {stderr}"))
    }
}

fn ydotool_paste(style: PasteKeystroke) -> Result<(), String> {
    if is_ydotool_v1() {
        match style {
            PasteKeystroke::CtrlV => ydotool_key(&["29:1", "47:1", "47:0", "29:0"]),
            PasteKeystroke::CtrlShiftV => {
                ydotool_key(&["29:1", "42:1", "47:1", "47:0", "42:0", "29:0"])
            }
            PasteKeystroke::ShiftInsert => ydotool_key(&["42:1", "110:1", "110:0", "42:0"]),
        }
    } else {
        match style {
            PasteKeystroke::CtrlV => ydotool_key(&["ctrl+v"]),
            PasteKeystroke::CtrlShiftV => ydotool_key(&["ctrl+shift+v"]),
            PasteKeystroke::ShiftInsert => ydotool_key(&["shift+insert"]),
        }
    }
}

fn ydotool_copy() -> Result<(), String> {
    if is_ydotool_v1() {
        ydotool_key(&["29:1", "46:1", "46:0", "29:0"])
    } else {
        ydotool_key(&["ctrl+c"])
    }
}

// --- wtype (works on Sway/Hyprland via virtual-keyboard protocol) ---

fn wtype_bin() -> Result<std::path::PathBuf, String> {
    super::compositor::wtype_path()
        .cloned()
        .ok_or_else(|| "wtype not found (not bundled and not in PATH)".to_string())
}

pub fn wtype_key(modifiers: &[&str], key: &str) -> Result<(), String> {
    let mut cmd = Command::new(wtype_bin()?);
    for m in modifiers {
        cmd.arg("-M").arg(*m);
    }
    cmd.arg("-k").arg(key);
    for m in modifiers.iter().rev() {
        cmd.arg("-m").arg(*m);
    }
    let status = cmd.status().map_err(|err| format!("wtype failed: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("wtype exited with non-zero status".into())
    }
}

// --- Simulate paste/copy keystrokes ---

fn simulate_paste_keystroke(style: PasteKeystroke) -> Result<(), String> {
    if ydotool_available() {
        log::info!("Using ydotool for paste keystroke ({style:?})");
        return ydotool_paste(style);
    }

    log::info!("ydotool not available, trying wtype for paste keystroke");
    match style {
        PasteKeystroke::CtrlV => wtype_key(&["ctrl"], "v"),
        PasteKeystroke::CtrlShiftV => wtype_key(&["ctrl", "shift"], "v"),
        PasteKeystroke::ShiftInsert => wtype_key(&["shift"], "Insert"),
    }
}

pub(crate) fn simulate_copy_keystroke() -> Result<(), String> {
    if ydotool_available() {
        return ydotool_copy();
    }
    wtype_key(&["ctrl"], "c")
}

// --- Public API ---

pub fn type_text_into_focused_field(
    text: &str,
    delay_ms: u64,
    cancel_flag: &std::sync::atomic::AtomicBool,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }

    log::info!(
        "attempting to type text ({} chars) with {}ms delay",
        text.chars().count(),
        delay_ms
    );

    if ydotool_available() {
        for c in text.chars() {
            if cancel_flag.load(std::sync::atomic::Ordering::SeqCst) {
                log::info!("Typing cancelled by user");
                return Err("Typing cancelled".into());
            }

            let c_str = c.to_string();
            let output = Command::new("ydotool")
                .arg("type")
                .arg(&c_str)
                .output()
                .map_err(|err| format!("ydotool type failed: {err}"))?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!(
                    "ydotool type exited with non-zero status: {stderr}"
                ));
            }

            if delay_ms > 0 {
                thread::sleep(Duration::from_millis(delay_ms));
            }
        }
        return Ok(());
    }

    Err(
        "Simulated typing on Wayland requires ydotool. Switch text insertion to Paste or install and configure ydotool."
            .to_string(),
    )
}

pub fn paste_text(
    text: &str,
    keybind: Option<&str>,
    skip_clipboard_restore: bool,
) -> Result<(), String> {
    paste_via_clipboard(text, keybind, skip_clipboard_restore).or_else(|err| {
        log::warn!("Wayland paste via keystroke failed ({err}), leaving text on clipboard");
        clipboard_set(text)
    })
}

fn paste_via_clipboard(
    text: &str,
    keybind: Option<&str>,
    skip_clipboard_restore: bool,
) -> Result<(), String> {
    let style = parse_paste_keystroke(keybind);
    let previous = if skip_clipboard_restore {
        None
    } else {
        clipboard_get().ok()
    };

    clipboard_set(text)?;
    thread::sleep(Duration::from_millis(40));

    simulate_paste_keystroke(style)?;

    if let Some(old) = previous {
        let pasted = text.to_string();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(800));
            if clipboard_get().is_ok_and(|current| current == pasted) {
                let _ = clipboard_set(&old);
            }
        });
    }

    Ok(())
}
