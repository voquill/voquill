#![allow(deprecated, unexpected_cfgs)]

#[macro_use]
extern crate objc;

pub mod ipc;

mod app;
mod constants;
mod draw;
mod gfx;
mod input;
mod state;

use std::sync::mpsc::Sender;

use ipc::{OutMessage, PillSender};

/// Start the pill overlay in embedded (library) mode.
/// Must be called from the main thread (Cocoa requirement).
/// Returns immediately — the pill hooks into the existing NSApplication run loop.
pub fn start(out_sender: Sender<OutMessage>) -> PillSender {
    let (sender, receiver) = ipc::channel();
    ipc::set_out_sender(out_sender);
    app::run_embedded(receiver);
    sender
}
