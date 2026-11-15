//! System audio on Windows: WASAPI loopback of the default output device
//! (cpal opens an input stream on an output device in loopback mode). It
//! needs no permission, and delivers nothing while nothing plays. The stream
//! is reopened when the default output device changes or the stream fails.
//! Loopback cannot leave a process out, so Voquill's own sounds would be
//! included; it plays none during a meeting (the dictation chimes are skipped).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream, StreamConfig};

use crate::platform::system_audio::{
    SystemAudioChunk, SystemAudioChunkCallback, SystemAudioSource, SystemAudioState,
    SystemAudioStateCallback,
};

const DEVICE_CHECK_INTERVAL: Duration = Duration::from_millis(500);
const RETRY_INTERVAL: Duration = Duration::from_secs(3);

#[derive(Default)]
pub struct LoopbackSource {
    stop: Mutex<Option<Arc<AtomicBool>>>,
}

impl SystemAudioSource for LoopbackSource {
    fn start(&self, on_chunk: SystemAudioChunkCallback, on_state: SystemAudioStateCallback) {
        self.stop();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let thread_state = on_state.clone();
        let spawned = std::thread::Builder::new()
            .name("meeting-system-audio".into())
            .spawn(move || run_loopback(&thread_stop, &on_chunk, &thread_state));
        match spawned {
            Ok(_) => *self.stop.lock().unwrap_or_else(|p| p.into_inner()) = Some(stop),
            Err(err) => {
                log::error!("Could not start the system audio thread: {err}");
                on_state(SystemAudioState::Failed);
            }
        }
    }

    fn stop(&self) {
        if let Some(stop) = self.stop.lock().unwrap_or_else(|p| p.into_inner()).take() {
            stop.store(true, Ordering::SeqCst);
        }
    }

    fn delivers_silence(&self) -> bool {
        false
    }
}

fn default_output_name() -> Option<String> {
    cpal::default_host()
        .default_output_device()
        .and_then(|device| device.name().ok())
}

/// Sleeps up to `duration`, waking early when the capture stops.
fn sleep_unless_stopped(stop: &AtomicBool, duration: Duration) {
    let until = Instant::now() + duration;
    while !stop.load(Ordering::SeqCst) && Instant::now() < until {
        std::thread::sleep(
            DEVICE_CHECK_INTERVAL.min(until.saturating_duration_since(Instant::now())),
        );
    }
}

/// The cpal stream lives on this thread only: it is not `Send` on Windows.
fn run_loopback(
    stop: &AtomicBool,
    on_chunk: &SystemAudioChunkCallback,
    on_state: &SystemAudioStateCallback,
) {
    let mut last_error: Option<String> = None;
    while !stop.load(Ordering::SeqCst) {
        match open_loopback(on_chunk) {
            Ok(loopback) => {
                last_error = None;
                on_state(SystemAudioState::Recording);
                while !stop.load(Ordering::SeqCst)
                    && !loopback.failed.load(Ordering::SeqCst)
                    && default_output_name() == loopback.device_name
                {
                    std::thread::sleep(DEVICE_CHECK_INTERVAL);
                }
                if !stop.load(Ordering::SeqCst) {
                    log::info!("System audio output changed or failed; reopening the loopback");
                }
            }
            Err(err) => {
                if last_error.as_ref() != Some(&err) {
                    log::warn!("System audio loopback could not start: {err}");
                }
                last_error = Some(err);
                on_state(SystemAudioState::Failed);
                sleep_unless_stopped(stop, RETRY_INTERVAL);
            }
        }
    }
}

struct Loopback {
    _stream: Stream,
    device_name: Option<String>,
    failed: Arc<AtomicBool>,
}

fn open_loopback(on_chunk: &SystemAudioChunkCallback) -> Result<Loopback, String> {
    let device = cpal::default_host()
        .default_output_device()
        .ok_or("No default output device")?;
    let device_name = device.name().ok();
    let config = device
        .default_output_config()
        .map_err(|err| err.to_string())?;
    let sample_format = config.sample_format();
    let stream_config: StreamConfig = config.into();
    let failed = Arc::new(AtomicBool::new(false));
    let stream = match sample_format {
        SampleFormat::F32 => build_loopback::<f32>(&device, &stream_config, on_chunk, &failed),
        SampleFormat::I16 => build_loopback::<i16>(&device, &stream_config, on_chunk, &failed),
        SampleFormat::U16 => build_loopback::<u16>(&device, &stream_config, on_chunk, &failed),
        other => Err(format!("Unsupported output format {other:?}")),
    }?;
    stream.play().map_err(|err| err.to_string())?;
    log::info!(
        "System audio loopback started on {:?} at {} Hz",
        device_name,
        stream_config.sample_rate.0
    );
    Ok(Loopback {
        _stream: stream,
        device_name,
        failed,
    })
}

fn build_loopback<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    on_chunk: &SystemAudioChunkCallback,
    failed: &Arc<AtomicBool>,
) -> Result<Stream, String>
where
    T: cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    let channels = usize::from(config.channels);
    let sample_rate = config.sample_rate.0;
    let on_chunk = Arc::clone(on_chunk);
    let failed = Arc::clone(failed);
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                let samples = crate::platform::audio::downmix_to_mono(data, channels);
                if !samples.is_empty() {
                    on_chunk(SystemAudioChunk {
                        samples,
                        sample_rate,
                    });
                }
            },
            move |err| {
                log::warn!("System audio loopback error: {err}");
                failed.store(true, Ordering::SeqCst);
            },
            None,
        )
        .map_err(|err| err.to_string())
}
