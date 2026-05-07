use super::wayland;
use enigo::{Enigo, Key, KeyboardControllable};
use std::{env, ffi::CStr, ptr, thread, time::Duration};
use x11::xlib;

pub(crate) fn paste_text_into_focused_field(text: &str, keybind: Option<&str>) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }

    let override_text = env::var("VOQUILL_DEBUG_PASTE_TEXT").ok();
    let target = override_text.as_deref().unwrap_or(text);
    eprintln!(
        "[voquill] attempting to inject text ({} chars)",
        target.chars().count()
    );

    if wayland::is_wayland() {
        eprintln!("[voquill] Wayland session detected");
        return wayland::wayland_paste_via_clipboard(target, keybind)
            .or_else(|err| {
                eprintln!("[voquill] Wayland paste failed ({err}), trying X11 fallback");
                paste_via_clipboard(target, keybind)
            })
            .or_else(|err| {
                eprintln!("[voquill] X11 paste failed ({err}), trying wtype text fallback");
                wayland::wtype_text(target)
            })
            .or_else(|err| {
                eprintln!("[voquill] wtype text failed ({err}), trying enigo typing fallback");
                enigo_type_text(target)
            });
    }

    paste_via_clipboard(target, keybind).or_else(|err| {
        eprintln!("Clipboard paste failed ({err}). Falling back to simulated typing.");
        enigo_type_text(target)
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

fn paste_via_clipboard(text: &str, keybind: Option<&str>) -> Result<(), String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|err| format!("clipboard unavailable: {err}"))?;
    let previous = clipboard.get_text().ok();
    clipboard
        .set_text(text.to_string())
        .map_err(|err| format!("failed to store clipboard text: {err}"))?;

    thread::sleep(Duration::from_millis(40));

    let mut enigo = Enigo::new();
    enigo.key_up(Key::Shift);
    enigo.key_up(Key::Control);
    enigo.key_up(Key::Alt);
    thread::sleep(Duration::from_millis(30));

    let use_shift = match keybind {
        Some(kb) => kb == "ctrl+shift+v",
        None => is_ctrl_shift_v_window(),
    };

    // Press and hold Ctrl
    enigo.key_down(Key::Control);
    thread::sleep(Duration::from_millis(10));

    // Press and hold Shift if needed
    if use_shift {
        enigo.key_down(Key::Shift);
        thread::sleep(Duration::from_millis(10));
    }

    // Press 'v'
    enigo.key_down(Key::Layout('v'));
    thread::sleep(Duration::from_millis(15));
    enigo.key_up(Key::Layout('v'));

    // Release Shift if pressed
    if use_shift {
        thread::sleep(Duration::from_millis(10));
        enigo.key_up(Key::Shift);
    }

    // Release Ctrl
    thread::sleep(Duration::from_millis(10));
    enigo.key_up(Key::Control);

    if let Some(old) = previous {
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(800));
            if let Ok(mut clipboard) = arboard::Clipboard::new() {
                let _ = clipboard.set_text(old);
            }
        });
    }

    Ok(())
}

const CTRL_SHIFT_V_WM_CLASSES: &[&str] = &[
    "gnome-terminal",
    "xterm",
    "kitty",
    "alacritty",
    "konsole",
    "xfce4-terminal",
    "terminator",
    "tilix",
    "urxvt",
    "rxvt",
    "st",
    "foot",
    "sakura",
    "terminology",
    "wezterm",
    "guake",
    "tilda",
    "yakuake",
    "rio",
    "cool-retro-term",
    "lxterminal",
    "mate-terminal",
    "deepin-terminal",
    "qterminal",
    "eterm",
    "aterm",
    "blackbox-terminal",
    "contour",
    "code",
    "code-insiders",
    "codium",
    "vscodium",
];

fn is_ctrl_shift_v_window() -> bool {
    let Some((res_name, res_class)) = get_focused_wm_class() else {
        // If detection fails, use conservative Ctrl+V (works everywhere)
        eprintln!("[voquill] focused window class detection failed, defaulting to Ctrl+V");
        return false;
    };

    eprintln!(
        "[voquill] focused window class: res_name={}, res_class={}",
        res_name, res_class
    );

    let name_lower = res_name.to_ascii_lowercase();
    let class_lower = res_class.to_ascii_lowercase();

    CTRL_SHIFT_V_WM_CLASSES
        .iter()
        .any(|t| name_lower == *t || class_lower == *t)
}

fn get_focused_wm_class() -> Option<(String, String)> {
    unsafe {
        let display = xlib::XOpenDisplay(ptr::null());
        if display.is_null() {
            return None;
        }

        let result = (|| {
            let mut focused: xlib::Window = 0;
            let mut revert: i32 = 0;
            xlib::XGetInputFocus(display, &mut focused, &mut revert);

            if focused == 0 || focused == 1 {
                return None;
            }

            let mut window = focused;
            for _ in 0..16 {
                let mut class_hint = xlib::XClassHint {
                    res_name: ptr::null_mut(),
                    res_class: ptr::null_mut(),
                };

                if xlib::XGetClassHint(display, window, &mut class_hint) != 0 {
                    let res_name = if class_hint.res_name.is_null() {
                        String::new()
                    } else {
                        let s = CStr::from_ptr(class_hint.res_name)
                            .to_string_lossy()
                            .into_owned();
                        xlib::XFree(class_hint.res_name as *mut _);
                        s
                    };

                    let res_class = if class_hint.res_class.is_null() {
                        String::new()
                    } else {
                        let s = CStr::from_ptr(class_hint.res_class)
                            .to_string_lossy()
                            .into_owned();
                        xlib::XFree(class_hint.res_class as *mut _);
                        s
                    };

                    if !res_name.is_empty() || !res_class.is_empty() {
                        return Some((res_name, res_class));
                    }
                }

                let mut root: xlib::Window = 0;
                let mut parent: xlib::Window = 0;
                let mut children: *mut xlib::Window = ptr::null_mut();
                let mut n_children: u32 = 0;

                if xlib::XQueryTree(
                    display,
                    window,
                    &mut root,
                    &mut parent,
                    &mut children,
                    &mut n_children,
                ) == 0
                {
                    return None;
                }

                if !children.is_null() {
                    xlib::XFree(children as *mut _);
                }

                if parent == root || parent == 0 {
                    return None;
                }

                window = parent;
            }

            None
        })();

        xlib::XCloseDisplay(display);
        result
    }
}
