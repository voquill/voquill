use std::collections::HashMap;
use std::sync::Mutex;

use tauri::async_runtime::JoinHandle;

/// Pending one-shot timers by id. Setting a timer again replaces the pending one.
#[derive(Default)]
pub struct WakeTimerState {
    timers: Mutex<HashMap<String, JoinHandle<()>>>,
}

impl WakeTimerState {
    pub fn replace(&self, id: String, timer: JoinHandle<()>) {
        if let Ok(mut timers) = self.timers.lock() {
            if let Some(previous) = timers.insert(id, timer) {
                previous.abort();
            }
        }
    }
}
