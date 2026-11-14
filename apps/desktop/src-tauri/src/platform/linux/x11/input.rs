use crate::platform::paste_keybind::{parse_paste_keystroke, PasteKeystroke};
use enigo::{Enigo, Key, KeyboardControllable};
use std::process::Command;
use std::sync::Mutex;
use std::{thread, time::Duration};

/// The clipboard owner of the latest paste, tagged with that paste's number so
/// an older paste's restore thread never drops a newer paste's hold.
static CLIPBOARD_HOLD: Mutex<Option<(u64, arboard::Clipboard)>> = Mutex::new(None);
static PASTE_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

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

    let mut enigo = Enigo::new();
    enigo.key_up(Key::Shift);
    enigo.key_up(Key::Control);
    enigo.key_up(Key::Alt);
    std::thread::sleep(std::time::Duration::from_millis(30));

    for c in text.chars() {
        if cancel_flag.load(std::sync::atomic::Ordering::SeqCst) {
            log::info!("Typing cancelled by user");
            return Err("Typing cancelled".into());
        }

        enigo.key_sequence(&c.to_string());

        if delay_ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        }
    }

    Ok(())
}

pub fn paste_text(
    text: &str,
    keybind: Option<&str>,
    skip_clipboard_restore: bool,
) -> Result<(), String> {
    paste_via_clipboard(text, keybind, skip_clipboard_restore).or_else(|err| {
        log::warn!("Clipboard paste failed ({err}), falling back to simulated typing");
        enigo_type_text(text)
    })
}

fn enigo_type_text(text: &str) -> Result<(), String> {
    let mut enigo = Enigo::new();
    enigo.key_up(Key::Shift);
    enigo.key_up(Key::Control);
    enigo.key_up(Key::Alt);
    thread::sleep(Duration::from_millis(30));
    enigo.key_sequence(text);
    Ok(())
}

fn xdotool_available() -> bool {
    Command::new("xdotool")
        .arg("version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn xdotool_key(combo: &str) -> Result<(), String> {
    let output = Command::new("xdotool")
        .arg("key")
        .arg("--clearmodifiers")
        .arg(combo)
        .output()
        .map_err(|err| format!("xdotool failed: {err}"))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "xdotool exited {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

fn simulate_paste_keystroke(style: PasteKeystroke) -> Result<(), String> {
    if xdotool_available() {
        let combo = match style {
            PasteKeystroke::CtrlV => "ctrl+v",
            PasteKeystroke::CtrlShiftV => "ctrl+shift+v",
            PasteKeystroke::ShiftInsert => "shift+Insert",
        };
        log::info!("Using xdotool for paste keystroke ({combo})");
        return xdotool_key(combo);
    }

    log::info!("xdotool not available, falling back to enigo");
    enigo_paste_keystroke(style)
}

fn enigo_paste_keystroke(style: PasteKeystroke) -> Result<(), String> {
    let mut enigo = Enigo::new();
    enigo.key_up(Key::Shift);
    enigo.key_up(Key::Control);
    enigo.key_up(Key::Alt);
    thread::sleep(Duration::from_millis(30));

    match style {
        PasteKeystroke::CtrlV => {
            enigo.key_down(Key::Control);
            enigo.key_down(Key::Layout('v'));
            thread::sleep(Duration::from_millis(15));
            enigo.key_up(Key::Layout('v'));
            enigo.key_up(Key::Control);
        }
        PasteKeystroke::CtrlShiftV => {
            enigo.key_down(Key::Control);
            enigo.key_down(Key::Shift);
            enigo.key_down(Key::Layout('v'));
            thread::sleep(Duration::from_millis(15));
            enigo.key_up(Key::Layout('v'));
            enigo.key_up(Key::Shift);
            enigo.key_up(Key::Control);
        }
        PasteKeystroke::ShiftInsert => {
            enigo.key_down(Key::Shift);
            enigo.key_down(Key::Insert);
            thread::sleep(Duration::from_millis(15));
            enigo.key_up(Key::Insert);
            enigo.key_up(Key::Shift);
        }
    }
    Ok(())
}

fn paste_via_clipboard(
    text: &str,
    keybind: Option<&str>,
    skip_clipboard_restore: bool,
) -> Result<(), String> {
    let style = parse_paste_keystroke(keybind);
    let mut clipboard =
        arboard::Clipboard::new().map_err(|err| format!("clipboard unavailable: {err}"))?;
    let previous = crate::platform::SavedClipboard::save(&mut clipboard);
    clipboard
        .set_text(text.to_string())
        .map_err(|err| format!("failed to store clipboard text: {err}"))?;

    let paste_id = PASTE_COUNT.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    {
        let mut hold = CLIPBOARD_HOLD.lock().unwrap_or_else(|p| p.into_inner());
        *hold = Some((paste_id, clipboard));
    }

    thread::sleep(Duration::from_millis(40));

    simulate_paste_keystroke(style)?;

    if skip_clipboard_restore {
        drop(previous);
    } else {
        let pasted = text.to_string();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(800));
            let unchanged = crate::platform::clipboard_holds_text(&pasted);
            let mut hold = CLIPBOARD_HOLD.lock().unwrap_or_else(|p| p.into_inner());
            if hold.as_ref().is_some_and(|(id, _)| *id == paste_id) {
                *hold = None;
            }
            drop(hold);
            if unchanged {
                previous.restore();
            }
        });
    }

    Ok(())
}
