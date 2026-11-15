use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, CGKeyCode};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use std::{thread, time::Duration};

use super::accessibility;

const KEY_A: CGKeyCode = 0;
const KEY_C: CGKeyCode = 8;
const KEY_SPACE: CGKeyCode = 49;
const KEY_V: CGKeyCode = 9;

pub(crate) fn type_text_into_focused_field(
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

    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
        .map_err(|_| "failed to create event source")?;

    for c in text.chars() {
        if cancel_flag.load(std::sync::atomic::Ordering::SeqCst) {
            log::info!("Typing cancelled by user");
            return Err("Typing cancelled".into());
        }

        if c == '\n' {
            let key_down = CGEvent::new_keyboard_event(source.clone(), 36, true)
                .map_err(|_| "failed to create return key-down event")?;
            key_down.post(CGEventTapLocation::HID);
            thread::sleep(Duration::from_millis(10));
            let key_up = CGEvent::new_keyboard_event(source.clone(), 36, false)
                .map_err(|_| "failed to create return key-up event")?;
            key_up.post(CGEventTapLocation::HID);
        } else {
            let event = CGEvent::new_keyboard_event(source.clone(), 0, true)
                .map_err(|_| "failed to create key event")?;
            event.set_string(&c.to_string());
            event.post(CGEventTapLocation::HID);
            thread::sleep(Duration::from_millis(10));
            let key_up = CGEvent::new_keyboard_event(source.clone(), 0, false)
                .map_err(|_| "failed to create key-up event")?;
            key_up.post(CGEventTapLocation::HID);
        }

        if delay_ms > 0 {
            thread::sleep(Duration::from_millis(delay_ms));
        }
    }

    Ok(())
}

pub(crate) fn paste_text_into_focused_field(
    text: &str,
    _keybind: Option<&str>,
    skip_clipboard_restore: bool,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }

    match accessibility::insert_text_at_cursor(text) {
        Ok(()) => Ok(()),
        Err(err) => {
            log::warn!("Accessibility insert failed ({err}), falling back to clipboard paste");
            paste_via_clipboard(text, skip_clipboard_restore)
        }
    }
}

fn paste_via_clipboard(text: &str, skip_clipboard_restore: bool) -> Result<(), String> {
    let trimmed_text = text.trim_end_matches(' ');
    let trailing_spaces = text.len() - trimmed_text.len();

    if !trimmed_text.is_empty() {
        let mut clipboard =
            arboard::Clipboard::new().map_err(|err| format!("clipboard unavailable: {err}"))?;
        let previous = crate::platform::SavedClipboard::save(&mut clipboard);
        clipboard
            .set_text(trimmed_text.to_string())
            .map_err(|err| format!("failed to store clipboard text: {err}"))?;

        thread::sleep(Duration::from_millis(50));
        simulate_cmd_v()?;

        if !skip_clipboard_restore {
            let pasted = trimmed_text.to_string();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(800));
                previous.restore_unless_replaced(&pasted);
            });
        }
    }

    for _ in 0..trailing_spaces {
        thread::sleep(Duration::from_millis(10));
        simulate_keypress(KEY_SPACE, CGEventFlags::empty())?;
    }

    Ok(())
}

pub(crate) fn simulate_cmd_c() -> Result<(), String> {
    // Use a private event source so physically-held modifier keys (e.g. Fn from the
    // hotkey combo) don't contaminate the synthetic Cmd+C event.
    let source = CGEventSource::new(CGEventSourceStateID::Private)
        .map_err(|_| "failed to create event source")?;

    let flags = CGEventFlags::CGEventFlagCommand;

    let key_down = CGEvent::new_keyboard_event(source.clone(), KEY_C, true)
        .map_err(|_| "failed to create key-down event")?;
    key_down.set_flags(flags);
    key_down.post(CGEventTapLocation::HID);

    thread::sleep(Duration::from_millis(10));

    let key_up = CGEvent::new_keyboard_event(source, KEY_C, false)
        .map_err(|_| "failed to create key-up event")?;
    key_up.set_flags(flags);
    key_up.post(CGEventTapLocation::HID);

    Ok(())
}

pub(crate) fn simulate_cmd_v() -> Result<(), String> {
    simulate_keypress(KEY_V, CGEventFlags::CGEventFlagCommand)
}

pub(crate) fn simulate_cmd_a() -> Result<(), String> {
    simulate_keypress(KEY_A, CGEventFlags::CGEventFlagCommand)
}

fn simulate_keypress(key_code: CGKeyCode, flags: CGEventFlags) -> Result<(), String> {
    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
        .map_err(|_| "failed to create event source")?;

    let key_down = CGEvent::new_keyboard_event(source.clone(), key_code, true)
        .map_err(|_| "failed to create key-down event")?;
    key_down.set_flags(flags);
    key_down.post(CGEventTapLocation::HID);

    thread::sleep(Duration::from_millis(10));

    let key_up = CGEvent::new_keyboard_event(source, key_code, false)
        .map_err(|_| "failed to create key-up event")?;
    key_up.set_flags(flags);
    key_up.post(CGEventTapLocation::HID);

    Ok(())
}
