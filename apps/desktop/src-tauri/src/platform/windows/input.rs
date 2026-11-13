use std::{
    env, mem, thread,
    time::{Duration, Instant},
};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, MapVirtualKeyW, SendInput, VkKeyScanW, INPUT, INPUT_0, INPUT_KEYBOARD,
    INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE,
    KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEINPUT,
    VIRTUAL_KEY, VK_A, VK_C, VK_CONTROL, VK_DELETE, VK_INSERT, VK_LCONTROL, VK_LMENU, VK_LSHIFT,
    VK_LWIN, VK_MENU, VK_RCONTROL, VK_RETURN, VK_RIGHT, VK_RMENU, VK_RSHIFT, VK_RWIN, VK_SHIFT,
    VK_TAB, VK_V,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW,
};

#[derive(Clone, Debug)]
pub struct WindowTargetInfo {
    pub class_name: Option<String>,
    pub title: Option<String>,
}

pub(crate) fn paste_text_into_focused_field(
    text: &str,
    keybind: Option<&str>,
    skip_clipboard_restore: bool,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }

    let override_text = env::var("VOQUILL_DEBUG_PASTE_TEXT").ok();
    let target = override_text.as_deref().unwrap_or(text);
    log::info!(
        "attempting to inject text ({} chars)",
        target.chars().count()
    );

    paste_via_clipboard(target, keybind, skip_clipboard_restore).or_else(|err| {
        log::warn!("Clipboard paste failed ({err}), falling back to simulated typing");
        use enigo::{Enigo, KeyboardControllable};
        let mut enigo = Enigo::new();
        release_modifier_keys();
        thread::sleep(Duration::from_millis(50));
        enigo.key_sequence(target);
        Ok(())
    })
}

fn is_console_window() -> bool {
    let target_info = get_foreground_window_target_info();
    if let Some(class_name) = target_info.class_name {
        log::debug!("foreground window class: {}", class_name);
        return class_name == "ConsoleWindowClass";
    }
    false
}

pub(crate) fn get_foreground_window_target_info() -> WindowTargetInfo {
    unsafe {
        let hwnd: HWND = GetForegroundWindow();
        if hwnd.0.is_null() {
            return WindowTargetInfo {
                class_name: None,
                title: None,
            };
        }

        let mut class_name = [0u16; 256];
        let class_len = GetClassNameW(hwnd, &mut class_name);
        let class_name = if class_len > 0 {
            Some(String::from_utf16_lossy(&class_name[..class_len as usize]))
        } else {
            None
        };

        let title_len = GetWindowTextLengthW(hwnd);
        let title = if title_len > 0 {
            let mut title_buf = vec![0u16; title_len as usize + 1];
            let copied = GetWindowTextW(hwnd, &mut title_buf);
            if copied > 0 {
                Some(String::from_utf16_lossy(&title_buf[..copied as usize]))
            } else {
                None
            }
        } else {
            None
        };

        WindowTargetInfo { class_name, title }
    }
}

pub(crate) fn simulate_copy_keystroke() {
    release_modifier_keys();
    thread::sleep(Duration::from_millis(30));
    send_key_down(VK_CONTROL);
    send_key_down(VK_C);
    thread::sleep(Duration::from_millis(20));
    send_key_up(VK_C);
    send_key_up(VK_CONTROL);
}

pub(crate) fn select_all_keystroke() {
    release_modifier_keys();
    thread::sleep(Duration::from_millis(30));
    send_key_down(VK_CONTROL);
    send_key_down(VK_A);
    thread::sleep(Duration::from_millis(20));
    send_key_up(VK_A);
    send_key_up(VK_CONTROL);
}

pub(crate) fn type_text_into_focused_field(
    text: &str,
    delay_ms: u64,
    cancel_flag: &std::sync::atomic::AtomicBool,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }

    let override_text = env::var("VOQUILL_DEBUG_PASTE_TEXT").ok();
    let target = override_text.as_deref().unwrap_or(text);
    log::info!(
        "attempting to type text ({} chars) with {}ms delay",
        target.chars().count(),
        delay_ms
    );

    release_modifier_keys();
    thread::sleep(Duration::from_millis(50));

    for c in target.chars() {
        if cancel_flag.load(std::sync::atomic::Ordering::SeqCst) {
            log::info!("Typing cancelled by user");
            return Err("Typing cancelled".into());
        }

        if !type_char_as_physical_key(c) {
            send_unicode_char(c);
        }

        if delay_ms > 0 {
            thread::sleep(Duration::from_millis(delay_ms));
        }
    }

    Ok(())
}

pub(crate) fn type_text_via_keystrokes(text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }
    use enigo::{Enigo, KeyboardControllable};
    let mut enigo = Enigo::new();
    release_modifier_keys();
    thread::sleep(Duration::from_millis(50));
    enigo.key_sequence(text);
    Ok(())
}

pub(crate) fn shift_select_right(count: usize) {
    if count == 0 {
        return;
    }
    send_key_down(VK_SHIFT);
    for _ in 0..count {
        send_key_down(VK_RIGHT);
        send_key_up(VK_RIGHT);
        thread::sleep(Duration::from_millis(5));
    }
    send_key_up(VK_SHIFT);
}

pub(crate) fn send_delete_keystroke() {
    send_key_down(VK_DELETE);
    thread::sleep(Duration::from_millis(10));
    send_key_up(VK_DELETE);
}

fn release_modifier_keys() {
    let win_held = is_key_pressed(VK_LWIN) || is_key_pressed(VK_RWIN);
    if win_held {
        cancel_pending_start_menu();
    }

    let modifiers = [
        VK_SHIFT,
        VK_CONTROL,
        VK_MENU,
        VK_LSHIFT,
        VK_RSHIFT,
        VK_LCONTROL,
        VK_RCONTROL,
        VK_LMENU,
        VK_RMENU,
        VK_LWIN,
        VK_RWIN,
    ];

    for vk in modifiers {
        if is_key_pressed(vk) {
            send_key_up(vk);
        }
    }
}

fn cancel_pending_start_menu() {
    let down = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0xFF),
                wScan: 0,
                dwFlags: Default::default(),
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let up = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0xFF),
                wScan: 0,
                dwFlags: KEYEVENTF_KEYUP,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    unsafe {
        SendInput(&[down, up], mem::size_of::<INPUT>() as i32);
    }
}

fn is_key_pressed(vk: VIRTUAL_KEY) -> bool {
    unsafe { GetAsyncKeyState(vk.0 as i32) < 0 }
}

fn send_key_down(vk: VIRTUAL_KEY) {
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: Default::default(),
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    unsafe {
        SendInput(&[input], mem::size_of::<INPUT>() as i32);
    }
}

fn send_key_up(vk: VIRTUAL_KEY) {
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: KEYEVENTF_KEYUP,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    unsafe {
        SendInput(&[input], mem::size_of::<INPUT>() as i32);
    }
}

fn type_char_as_physical_key(c: char) -> bool {
    match c {
        '\n' => return send_scancode_tap(VK_RETURN),
        '\t' => return send_scancode_tap(VK_TAB),
        _ => {}
    }

    let mut utf16 = [0u16; 2];
    let encoded = c.encode_utf16(&mut utf16);
    if encoded.len() != 1 {
        return false;
    }

    let vk_scan = unsafe { VkKeyScanW(encoded[0]) };
    if vk_scan == -1 {
        return false;
    }

    let vk_scan = vk_scan as u16;
    let vk = VIRTUAL_KEY(vk_scan & 0xff);
    let shift_state = ((vk_scan >> 8) & 0xff) as u8;
    if shift_state & !0x07 != 0 {
        return false;
    }

    let modifiers = [
        (shift_state & 0x01 != 0, VK_SHIFT),
        (shift_state & 0x02 != 0, VK_CONTROL),
        (shift_state & 0x04 != 0, VK_MENU),
    ];

    let mut pressed_modifiers = [VIRTUAL_KEY(0); 3];
    let mut pressed_modifier_count = 0;

    for &(needed, modifier) in &modifiers {
        if needed {
            if !send_scancode_key_down(modifier) {
                for modifier in pressed_modifiers[..pressed_modifier_count].iter().rev() {
                    send_scancode_key_up(*modifier);
                }
                return false;
            }
            pressed_modifiers[pressed_modifier_count] = modifier;
            pressed_modifier_count += 1;
        }
    }

    let sent = send_scancode_tap(vk);

    for modifier in pressed_modifiers[..pressed_modifier_count].iter().rev() {
        send_scancode_key_up(*modifier);
    }

    sent
}

fn send_scancode_tap(vk: VIRTUAL_KEY) -> bool {
    if !send_scancode_key_down(vk) {
        return false;
    }
    thread::sleep(Duration::from_millis(2));
    send_scancode_key_up(vk)
}

fn send_scancode_key_down(vk: VIRTUAL_KEY) -> bool {
    send_scancode_key(vk, Default::default())
}

fn send_scancode_key_up(vk: VIRTUAL_KEY) -> bool {
    send_scancode_key(vk, KEYEVENTF_KEYUP)
}

fn send_scancode_key(vk: VIRTUAL_KEY, extra_flags: KEYBD_EVENT_FLAGS) -> bool {
    let scan_code = unsafe { MapVirtualKeyW(vk.0 as u32, MAPVK_VK_TO_VSC) };
    if scan_code == 0 {
        return false;
    }

    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: scan_code as u16,
                dwFlags: KEYEVENTF_SCANCODE | extra_flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    unsafe {
        SendInput(&[input], mem::size_of::<INPUT>() as i32);
    }
    true
}

fn send_unicode_char(c: char) {
    let mut utf16 = [0u16; 2];
    for unit in c.encode_utf16(&mut utf16) {
        send_unicode_unit(*unit);
    }
}

fn send_unicode_unit(unit: u16) {
    let down = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: unit,
                dwFlags: KEYEVENTF_UNICODE,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let up = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: unit,
                dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    unsafe {
        SendInput(&[down, up], mem::size_of::<INPUT>() as i32);
    }
}

fn send_right_click() {
    let down = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: 0,
                dwFlags: MOUSEEVENTF_RIGHTDOWN,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let up = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: 0,
                dwFlags: MOUSEEVENTF_RIGHTUP,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    unsafe {
        SendInput(&[down], mem::size_of::<INPUT>() as i32);
        thread::sleep(Duration::from_millis(10));
        SendInput(&[up], mem::size_of::<INPUT>() as i32);
    }
}

fn send_paste_keys(keybind: Option<&str>) {
    use crate::platform::paste_keybind::{parse_paste_keystroke, PasteKeystroke};

    let is_console = is_console_window();
    match parse_paste_keystroke(keybind) {
        PasteKeystroke::CtrlV if is_console => {
            log::info!("detected console window, using right-click to paste");
            send_right_click();
        }
        PasteKeystroke::CtrlV => {
            send_key_down(VK_CONTROL);
            send_key_down(VK_V);
            thread::sleep(Duration::from_millis(20));
            send_key_up(VK_V);
            send_key_up(VK_CONTROL);
        }
        PasteKeystroke::CtrlShiftV => {
            send_key_down(VK_CONTROL);
            send_key_down(VK_SHIFT);
            send_key_down(VK_V);
            thread::sleep(Duration::from_millis(20));
            send_key_up(VK_V);
            send_key_up(VK_SHIFT);
            send_key_up(VK_CONTROL);
        }
        PasteKeystroke::ShiftInsert => {
            send_key_down(VK_SHIFT);
            send_key_down(VK_INSERT);
            thread::sleep(Duration::from_millis(20));
            send_key_up(VK_INSERT);
            send_key_up(VK_SHIFT);
        }
    }
}

fn paste_via_clipboard(
    text: &str,
    keybind: Option<&str>,
    skip_clipboard_restore: bool,
) -> Result<(), String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|err| format!("clipboard unavailable: {err}"))?;
    let previous = crate::platform::SavedClipboard::save(&mut clipboard);
    clipboard
        .set_text(text.to_string())
        .map_err(|err| format!("failed to store clipboard text: {err}"))?;

    // Windows' clipboard-change broadcast reaches other processes via the
    // message pump, not synchronously. If we fire Ctrl+V before the target
    // app has observed the new contents, paste fetches the previous value —
    // which during batched writes leaks earlier fields' values into later
    // ones. Poll the clipboard until readback matches what we wrote.
    if !text.is_empty() {
        let deadline = Instant::now() + Duration::from_millis(1000);
        loop {
            match clipboard.get_text() {
                Ok(ref read) if read == text => break,
                _ => {
                    if Instant::now() >= deadline {
                        return Err("clipboard verification timed out".into());
                    }
                    thread::sleep(Duration::from_millis(10));
                }
            }
        }
    }

    release_modifier_keys();
    thread::sleep(Duration::from_millis(30));

    send_paste_keys(keybind);

    if !skip_clipboard_restore {
        let pasted = text.to_string();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(800));
            previous.restore_unless_replaced(&pasted);
        });
    }

    Ok(())
}
