mod constants;
mod draw;
mod input;
mod ipc;
mod pill;
mod state;
mod x11;

fn main() {
    gtk::init().expect("Failed to initialize GTK");

    // Compositors without layer-shell support (notably GNOME/Mutter) fall
    // into the PlainWayland backend, which renders and positions the pill
    // incorrectly (maximized dock-hint window, broken loading phase).
    // XWayland behaves exactly like plain X11, which works well, so re-exec
    // ourselves with the x11 GDK backend there. Compositors with layer-shell
    // (KDE, sway, Hyprland, ...) are unaffected.
    //
    // The host app exports GDK_BACKEND=wayland to its children, so only our
    // own "x11" value is treated as the already-re-executed marker (this
    // also prevents an exec loop).
    let already_x11 = std::env::var("GDK_BACKEND").map(|v| v == "x11").unwrap_or(false);
    if !already_x11 && !gtk_layer_shell::is_supported() {
        use gtk::prelude::*;
        let is_x11_display = gtk::gdk::Display::default()
            .map(|d| d.type_().name() == "GdkX11Display")
            .unwrap_or(false);
        if !is_x11_display {
            if let Ok(exe) = std::env::current_exe() {
                use std::os::unix::process::CommandExt;
                let err = std::process::Command::new(exe)
                    .env("GDK_BACKEND", "x11")
                    .exec();
                eprintln!("re-exec with GDK_BACKEND=x11 failed ({err}), staying on wayland");
            }
        }
    }

    let (sender, receiver) = async_channel::unbounded();
    ipc::start_stdin_reader(sender);
    pill::run(receiver);
}
