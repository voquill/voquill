use std::process::Command;
use std::{thread, time::Duration};

pub fn is_wayland() -> bool {
    // Check GDK_BACKEND first - if explicitly set to x11, don't use Wayland
    if let Ok(backend) = std::env::var("GDK_BACKEND") {
        if backend.to_lowercase().contains("x11") {
            return false;
        }
    }
    // Then check WAYLAND_DISPLAY
    std::env::var("WAYLAND_DISPLAY").is_ok()
}

pub fn wl_copy(text: &str) -> Result<(), String> {
    let status = Command::new("wl-copy")
        .arg("--")
        .arg(text)
        .status()
        .map_err(|err| format!("wl-copy failed: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("wl-copy exited with non-zero status".into())
    }
}

pub fn wl_paste() -> Result<String, String> {
    let output = Command::new("wl-paste")
        .arg("--no-newline")
        .output()
        .map_err(|err| format!("wl-paste failed: {err}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err("wl-paste exited with non-zero status".into())
    }
}

pub fn wtype_key(modifiers: &[&str], key: &str) -> Result<(), String> {
    let mut cmd = Command::new("wtype");
    for m in modifiers {
        cmd.arg("-M").arg(*m);
    }
    cmd.arg("-k").arg(key);
    for m in modifiers.iter().rev() {
        cmd.arg("-m").arg(*m);
    }
    let status = cmd
        .status()
        .map_err(|err| format!("wtype failed: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("wtype exited with non-zero status".into())
    }
}

pub fn wtype_text(text: &str) -> Result<(), String> {
    let status = Command::new("wtype")
        .arg("--")
        .arg(text)
        .status()
        .map_err(|err| format!("wtype failed: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("wtype exited with non-zero status".into())
    }
}

pub fn wayland_paste_via_clipboard(text: &str, keybind: Option<&str>) -> Result<(), String> {
    let previous = wl_paste().ok();

    wl_copy(text)?;
    thread::sleep(Duration::from_millis(40));

    let use_shift = match keybind {
        Some(kb) => kb == "ctrl+shift+v",
        None => false,
    };

    if use_shift {
        wtype_key(&["ctrl", "shift"], "v")?;
    } else {
        wtype_key(&["ctrl"], "v")?;
    }

    if let Some(old) = previous {
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(800));
            let _ = wl_copy(&old);
        });
    }

    Ok(())
}

pub fn wayland_get_selected_text() -> Option<String> {
    let previous = wl_paste().ok();

    wtype_key(&["ctrl"], "c").ok()?;
    thread::sleep(Duration::from_millis(50));

    let selected = wl_paste().ok();

    if let Some(old) = previous {
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            let _ = wl_copy(&old);
        });
    }

    selected.filter(|s| !s.is_empty())
}
