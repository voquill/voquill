#![allow(deprecated, unexpected_cfgs)]

#[macro_use]
extern crate objc;

mod app;
mod constants;
mod draw;
mod gfx;
mod input;
mod ipc;
mod state;

fn main() {
    let (sender, receiver) = ipc::channel();
    ipc::start_stdin_reader(sender);
    app::run(receiver);
}
