use crate::platform::macos::dock;
use cocoa::appkit::{NSApp, NSApplication, NSWindow, NSWindowCollectionBehavior};
use cocoa::base::{id, nil, BOOL, YES};
use objc::{msg_send, sel, sel_impl};
use std::sync::mpsc;
use tauri::WebviewWindow;

pub fn surface_main_window(window: &WebviewWindow) -> Result<(), String> {
    let window_for_handle = window.clone();
    let (tx, rx) = mpsc::channel();

    window
        .run_on_main_thread(move || {
            let result = (|| -> Result<(), String> {
                if let Err(err) = dock::show_dock_icon() {
                    log::error!("Failed to show dock icon: {err}");
                }

                let ns_window_ptr = window_for_handle
                    .ns_window()
                    .map_err(|err| err.to_string())?;

                unsafe {
                    let ns_window = ns_window_ptr as id;
                    let ns_app = NSApp();
                    if ns_app != nil {
                        NSApplication::activateIgnoringOtherApps_(ns_app, YES);
                    }

                    ns_window.deminiaturize_(nil);
                    ns_window.makeKeyWindow();
                    ns_window.orderFrontRegardless();
                }

                if let Err(err) = window_for_handle.unminimize() {
                    log::error!("Failed to unminimize window: {err}");
                }
                if let Err(err) = window_for_handle.show() {
                    log::error!("Failed to show window: {err}");
                }
                if let Err(err) = window_for_handle.set_focus() {
                    log::error!("Failed to focus window: {err}");
                }

                Ok(())
            })();

            let _ = tx.send(result);
        })
        .map_err(|err| err.to_string())?;

    rx.recv()
        .map_err(|_| "failed to surface window on main thread".to_string())?
}

/// Turns an always-on-top window into an overlay: visible on every Space,
/// including over other apps' fullscreen windows, and clickable without
/// making Voquill the active app. The window level is left alone so system
/// notification banners still draw above it.
pub fn make_overlay(window: &WebviewWindow) -> Result<(), String> {
    let window_for_handle = window.clone();

    window
        .run_on_main_thread(move || match window_for_handle.ns_window() {
            Ok(ns_window_ptr) => unsafe {
                let ns_window = ns_window_ptr as id;
                ns_window.setCollectionBehavior_(
                    NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                        | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
                        | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary
                        | NSWindowCollectionBehavior::NSWindowCollectionBehaviorIgnoresCycle,
                );

                // What a non-activating NSPanel sets on itself. AppKit has no
                // public way to ask for it on a window that already exists.
                let prevents_activation = sel!(_setPreventsActivation:);
                let supported: BOOL = msg_send![ns_window, respondsToSelector: prevents_activation];
                if supported == YES {
                    let _: () = msg_send![ns_window, _setPreventsActivation: YES];
                } else {
                    log::warn!("This macOS cannot keep overlay clicks from activating Voquill");
                }
            },
            Err(err) => log::error!("Failed to turn window into an overlay: {err}"),
        })
        .map_err(|err| err.to_string())
}
