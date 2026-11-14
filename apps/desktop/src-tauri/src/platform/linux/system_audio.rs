//! System audio on Linux: the monitor source of the default PulseAudio (or
//! PipeWire through pipewire-pulse) sink. It needs no permission. The stream
//! is reopened on the new monitor when the default sink changes. A monitor
//! cannot leave a process out, so Voquill's own sounds would be included; it
//! plays none during a meeting (the dictation chimes are skipped).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::platform::linux::audio::{default_sink_monitor, open_record_stream, read_samples};
use crate::platform::system_audio::{
    SystemAudioChunk, SystemAudioChunkCallback, SystemAudioSource, SystemAudioState,
    SystemAudioStateCallback,
};

const SINK_CHECK_INTERVAL: Duration = Duration::from_secs(2);
const RETRY_INTERVAL: Duration = Duration::from_secs(3);

#[derive(Default)]
pub struct MonitorSource {
    stop: Mutex<Option<Arc<AtomicBool>>>,
}

impl SystemAudioSource for MonitorSource {
    fn start(&self, on_chunk: SystemAudioChunkCallback, on_state: SystemAudioStateCallback) {
        self.stop();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let thread_state = on_state.clone();
        let spawned = std::thread::Builder::new()
            .name("meeting-system-audio".into())
            .spawn(move || run_monitor(&thread_stop, &on_chunk, &thread_state));
        match spawned {
            Ok(_) => *self.stop.lock().unwrap_or_else(|p| p.into_inner()) = Some(stop),
            Err(err) => {
                log::error!("Could not start the system audio thread: {err}");
                on_state(SystemAudioState::Failed);
            }
        }
    }

    /// The reading thread notices at its next fragment (about 20 ms) and
    /// closes the stream; nothing waits for it.
    fn stop(&self) {
        if let Some(stop) = self.stop.lock().unwrap_or_else(|p| p.into_inner()).take() {
            stop.store(true, Ordering::SeqCst);
        }
    }

    /// Unverified whether every server keeps a monitor delivering silence,
    /// so a quiet monitor is not taken for a stalled one.
    fn delivers_silence(&self) -> bool {
        false
    }
}

fn sleep_unless_stopped(stop: &AtomicBool, duration: Duration) {
    let until = Instant::now() + duration;
    while !stop.load(Ordering::SeqCst) && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn run_monitor(
    stop: &AtomicBool,
    on_chunk: &SystemAudioChunkCallback,
    on_state: &SystemAudioStateCallback,
) {
    let mut last_error: Option<String> = None;
    while !stop.load(Ordering::SeqCst) {
        let opened = default_sink_monitor()
            .ok_or_else(|| "No default sink monitor".to_string())
            .and_then(|monitor| {
                open_record_stream(
                    Some(&monitor.name),
                    monitor.sample_rate,
                    "Meeting system audio",
                )
                .map(|stream| (monitor, stream))
            });
        let (monitor, stream) = match opened {
            Ok(opened) => opened,
            Err(err) => {
                if last_error.as_ref() != Some(&err) {
                    log::warn!("System audio monitor could not start: {err}");
                }
                last_error = Some(err);
                on_state(SystemAudioState::Failed);
                sleep_unless_stopped(stop, RETRY_INTERVAL);
                continue;
            }
        };
        last_error = None;
        log::info!(
            "System audio monitor started on {} at {} Hz",
            monitor.name,
            monitor.sample_rate
        );
        on_state(SystemAudioState::Recording);

        let mut checked_at = Instant::now();
        while !stop.load(Ordering::SeqCst) {
            match read_samples(&stream) {
                Ok(samples) => on_chunk(SystemAudioChunk {
                    samples,
                    sample_rate: monitor.sample_rate,
                }),
                Err(err) => {
                    log::warn!("System audio monitor read failed: {err}");
                    on_state(SystemAudioState::Failed);
                    break;
                }
            }
            if checked_at.elapsed() >= SINK_CHECK_INTERVAL {
                checked_at = Instant::now();
                let current = default_sink_monitor().map(|source| source.name);
                if current.as_deref() != Some(monitor.name.as_str()) {
                    log::info!("Default sink changed; reopening the system audio monitor");
                    break;
                }
            }
        }
    }
}
