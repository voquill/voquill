use crate::domain::{RecordedAudio, RecordingMetrics, RecordingResult};
use crate::errors::RecordingError;
use crate::platform::audio::InputDeviceDescriptor;
use crate::platform::{ChunkCallback, LevelCallback, Recorder};
use std::cmp;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use libpulse_binding as pulse;
use libpulse_binding::mainloop::standard::Mainloop;
use libpulse_simple_binding as psimple;

const FALLBACK_SAMPLE_RATE: u32 = 44_100;
const LEVEL_BIN_COUNT: usize = 12;
const LEVEL_DISPATCH_INTERVAL: Duration = Duration::from_millis(48);
const CHUNK_DISPATCH_INTERVAL: Duration = Duration::from_millis(100);
const READ_CHUNK_FRAMES: usize = 1024;
const PULSE_OPEN_TIMEOUT: Duration = Duration::from_secs(5);

pub struct PulseRecorder {
    inner: Arc<Mutex<Option<ActiveRecording>>>,
    preferred_source: Arc<Mutex<Option<String>>>,
    retain_samples: bool,
}

struct ActiveRecording {
    stop_signal: Arc<Mutex<bool>>,
    thread: Option<std::thread::JoinHandle<RecordingResult>>,
    sample_rate: u32,
}

unsafe impl Send for PulseRecorder {}
unsafe impl Sync for PulseRecorder {}

impl Default for PulseRecorder {
    fn default() -> Self {
        Self::new()
    }
}

impl PulseRecorder {
    pub fn new() -> Self {
        Self::with_sample_retention(true)
    }

    pub fn with_sample_retention(retain_samples: bool) -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
            preferred_source: Arc::new(Mutex::new(None)),
            retain_samples,
        }
    }
}

impl Recorder for PulseRecorder {
    fn start(
        &self,
        level_callback: Option<LevelCallback>,
        chunk_callback: Option<ChunkCallback>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RecordingError::AlreadyRecording)?;

        if guard.is_some() {
            return Err(Box::new(RecordingError::AlreadyRecording));
        }

        let preferred = {
            let pref_guard = self
                .preferred_source
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            pref_guard.clone()
        };

        // Resolve the PulseAudio source name to record from.
        // If the user picked a device by its display label, map it back
        // to the underlying PulseAudio source name.
        let source_name = resolve_source_name(preferred.as_deref());
        let native_rate = query_source_native_rate(source_name.as_deref());

        log::info!(
            "PulseAudio native sample rate for source {:?}: {}",
            source_name.as_deref().unwrap_or("default"),
            native_rate,
        );

        let stop_signal = Arc::new(Mutex::new(false));
        let stop_signal_clone = Arc::clone(&stop_signal);
        let retain_samples = self.retain_samples;
        let (opened, opened_result) = std::sync::mpsc::channel();

        let thread = std::thread::Builder::new()
            .name("pulse-recorder".into())
            .spawn(move || {
                record_loop(
                    source_name.as_deref(),
                    native_rate,
                    stop_signal_clone,
                    level_callback,
                    chunk_callback,
                    retain_samples,
                    opened,
                )
            })
            .map_err(|err| RecordingError::StreamBuild(err.to_string()))?;

        // Starting succeeds only once the stream is open, so a missing or
        // stopped PulseAudio is reported instead of a silent recording.
        let open = opened_result
            .recv_timeout(PULSE_OPEN_TIMEOUT)
            .unwrap_or_else(|_| Err("PulseAudio did not open the stream in time".into()));
        if let Err(message) = open {
            if let Ok(mut flag) = stop_signal.lock() {
                *flag = true;
            }
            let _ = thread.join();
            return Err(Box::new(RecordingError::StreamBuild(message)));
        }

        *guard = Some(ActiveRecording {
            stop_signal,
            thread: Some(thread),
            sample_rate: native_rate,
        });

        Ok(())
    }

    fn stop(&self) -> Result<RecordingResult, Box<dyn std::error::Error>> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RecordingError::NotRecording)?;
        let mut recording = guard.take().ok_or(RecordingError::NotRecording)?;

        // Signal the recording thread to stop
        if let Ok(mut flag) = recording.stop_signal.lock() {
            *flag = true;
        }

        let thread = recording
            .thread
            .take()
            .ok_or(RecordingError::NotRecording)?;
        let result = thread
            .join()
            .map_err(|_| RecordingError::StreamBuild("recording thread panicked".into()))?;

        Ok(result)
    }

    fn set_preferred_input_device(&self, name: Option<String>) {
        let sanitized = name.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        match self.preferred_source.lock() {
            Ok(mut guard) => *guard = sanitized,
            Err(poisoned) => *poisoned.into_inner() = sanitized,
        }
    }

    fn clear_device_cache(&self) {
        // No caching needed — PulseAudio handles device routing
    }

    fn current_sample_rate(&self) -> Option<u32> {
        let guard = match self.inner.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        guard.as_ref().map(|r| r.sample_rate)
    }
}

/// Given the user's preferred device label (the display name shown in the UI),
/// look up the PulseAudio source name that corresponds to it. Returns None
/// to use the server default.
fn resolve_source_name(preferred_label: Option<&str>) -> Option<String> {
    let label = preferred_label?;
    if label.is_empty() {
        return None;
    }

    // If the label is already a PulseAudio source name (e.g. "alsa_input.usb-..."),
    // use it directly.
    if label.starts_with("alsa_input.") || label.starts_with("alsa_output.") {
        return Some(label.to_string());
    }

    // Otherwise, enumerate sources and find the one whose description matches.
    let sources = enumerate_pulse_sources();
    let label_lower = label.to_ascii_lowercase();

    sources
        .into_iter()
        .find(|s| s.description.to_ascii_lowercase() == label_lower)
        .map(|s| s.name)
}

/// Query the native sample rate of a PulseAudio source. Falls back to the
/// default source, then to `FALLBACK_SAMPLE_RATE` if enumeration fails.
fn query_source_native_rate(source_name: Option<&str>) -> u32 {
    let sources = enumerate_pulse_sources();

    if let Some(name) = source_name {
        if let Some(source) = sources.iter().find(|s| s.name == name) {
            return source.sample_rate;
        }
    }

    if let Some(source) = sources.iter().find(|s| s.is_default) {
        return source.sample_rate;
    }

    FALLBACK_SAMPLE_RATE
}

/// A blocking mono f32 recording stream on `source_name` (None = default).
pub(crate) fn open_record_stream(
    source_name: Option<&str>,
    sample_rate: u32,
    description: &str,
) -> Result<psimple::Simple, String> {
    let spec = pulse::sample::Spec {
        format: pulse::sample::Format::F32le,
        channels: 1,
        rate: sample_rate,
    };

    let attr = pulse::def::BufferAttr {
        maxlength: u32::MAX,
        tlength: u32::MAX,
        prebuf: u32::MAX,
        minreq: u32::MAX,
        // Keep the fragment size small for low-latency level/chunk callbacks
        fragsize: (READ_CHUNK_FRAMES * std::mem::size_of::<f32>()) as u32,
    };

    psimple::Simple::new(
        None,      // server (default)
        "Voquill", // app name
        pulse::stream::Direction::Record,
        source_name, // source (None = default)
        description,
        &spec,
        None, // channel map (default)
        Some(&attr),
    )
    // `PAErr::to_string` is an inherent method returning an `Option`.
    .map_err(|err| format!("{err}"))
}

/// Reads one fragment (`READ_CHUNK_FRAMES` samples), blocking until it is there.
pub(crate) fn read_samples(simple: &psimple::Simple) -> Result<Vec<f32>, String> {
    let mut read_buf = vec![0u8; READ_CHUNK_FRAMES * std::mem::size_of::<f32>()];
    simple.read(&mut read_buf).map_err(|err| format!("{err}"))?;
    Ok(read_buf
        .as_chunks::<4>()
        .0
        .iter()
        .map(|chunk| f32::from_le_bytes(*chunk))
        .collect())
}

/// The actual blocking recording loop. Runs on a dedicated thread.
fn record_loop(
    source_name: Option<&str>,
    sample_rate: u32,
    stop_signal: Arc<Mutex<bool>>,
    level_callback: Option<LevelCallback>,
    chunk_callback: Option<ChunkCallback>,
    retain_samples: bool,
    opened: std::sync::mpsc::Sender<Result<(), String>>,
) -> RecordingResult {
    let simple = match open_record_stream(source_name, sample_rate, "Recording") {
        Ok(s) => s,
        Err(err) => {
            log::error!("failed to open PulseAudio recording stream: {err}");
            let _ = opened.send(Err(err));
            return empty_result();
        }
    };
    let _ = opened.send(Ok(()));

    log::info!(
        "PulseAudio recording started (source: {})",
        source_name.unwrap_or("default")
    );

    let start = Instant::now();
    let mut all_samples: Vec<f32> = Vec::new();
    let mut last_level_emit = Instant::now();
    let mut last_chunk_emit = Instant::now();
    let mut chunk_buffer: Vec<f32> = Vec::new();

    loop {
        // Check stop signal
        if let Ok(flag) = stop_signal.lock() {
            if *flag {
                break;
            }
        }

        // Read audio data (blocking)
        let samples = match read_samples(&simple) {
            Ok(samples) => samples,
            Err(err) => {
                log::error!("PulseAudio read error: {err}");
                break;
            }
        };

        if retain_samples {
            all_samples.extend_from_slice(&samples);
        }

        // Emit level bins
        if let Some(ref cb) = level_callback {
            let now = Instant::now();
            if now.duration_since(last_level_emit) >= LEVEL_DISPATCH_INTERVAL {
                last_level_emit = now;
                let levels = compute_level_bins(&samples);
                cb(levels);
            }
        }

        // Emit audio chunks
        if let Some(ref cb) = chunk_callback {
            chunk_buffer.extend_from_slice(&samples);
            let now = Instant::now();
            if now.duration_since(last_chunk_emit) >= CHUNK_DISPATCH_INTERVAL {
                last_chunk_emit = now;
                if !chunk_buffer.is_empty() {
                    cb(chunk_buffer.clone());
                    chunk_buffer.clear();
                }
            }
        }
    }

    // Flush remaining chunk buffer
    if let Some(ref cb) = chunk_callback {
        if !chunk_buffer.is_empty() {
            cb(chunk_buffer);
        }
    }

    let duration = if !all_samples.is_empty() {
        Duration::from_secs_f64(all_samples.len() as f64 / f64::from(sample_rate))
    } else {
        start.elapsed()
    };
    let size_bytes = all_samples.len() as u64 * std::mem::size_of::<f32>() as u64;

    RecordingResult {
        metrics: RecordingMetrics {
            duration,
            size_bytes,
        },
        audio: RecordedAudio {
            samples: all_samples,
            sample_rate,
        },
    }
}

fn empty_result() -> RecordingResult {
    RecordingResult {
        metrics: RecordingMetrics {
            duration: Duration::ZERO,
            size_bytes: 0,
        },
        audio: RecordedAudio {
            samples: Vec::new(),
            sample_rate: FALLBACK_SAMPLE_RATE,
        },
    }
}

fn compute_level_bins(samples: &[f32]) -> Vec<f32> {
    if samples.is_empty() {
        return vec![0.0; LEVEL_BIN_COUNT];
    }

    let frames_per_bin = cmp::max(1, samples.len() / LEVEL_BIN_COUNT);
    let mut bins = vec![0.0f32; LEVEL_BIN_COUNT];
    let mut counts = vec![0u32; LEVEL_BIN_COUNT];

    for (index, sample) in samples.iter().enumerate() {
        let bin_index = cmp::min(index / frames_per_bin, LEVEL_BIN_COUNT - 1);
        bins[bin_index] += sample.abs();
        counts[bin_index] += 1;
    }

    for (value, count) in bins.iter_mut().zip(counts) {
        if count > 0 {
            *value = (*value / count as f32).clamp(0.0, 1.0);
        }
    }

    bins
}

// ── PulseAudio source enumeration ──────────────────────────────────────

#[derive(Clone)]
pub(crate) struct PulseSource {
    pub(crate) name: String,
    description: String,
    is_monitor: bool,
    is_default: bool,
    /// The monitor of the default sink: what the computer plays.
    is_default_sink_monitor: bool,
    pub(crate) sample_rate: u32,
}

fn enumerate_pulse_sources() -> Vec<PulseSource> {
    let mut ml = match Mainloop::new() {
        Some(ml) => ml,
        None => {
            log::error!("failed to create PulseAudio mainloop");
            return Vec::new();
        }
    };

    let mut ctx = match pulse::context::Context::new(&ml, "Voquill Enumerate") {
        Some(ctx) => ctx,
        None => {
            log::error!("failed to create PulseAudio context");
            return Vec::new();
        }
    };

    if ctx
        .connect(None, pulse::context::FlagSet::NOFLAGS, None)
        .is_err()
    {
        log::error!("failed to connect PulseAudio context");
        return Vec::new();
    }

    // Wait for context to be ready
    loop {
        match ml.iterate(true) {
            pulse::mainloop::standard::IterateResult::Quit(_)
            | pulse::mainloop::standard::IterateResult::Err(_) => {
                log::error!("PulseAudio mainloop error during connect");
                return Vec::new();
            }
            _ => {}
        }
        match ctx.get_state() {
            pulse::context::State::Ready => break,
            pulse::context::State::Failed | pulse::context::State::Terminated => {
                log::error!("PulseAudio context failed to connect");
                return Vec::new();
            }
            _ => {}
        }
    }

    // Get the default source and sink names from server info
    let default_source: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let default_source_clone = Arc::clone(&default_source);
    let default_sink: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let default_sink_clone = Arc::clone(&default_sink);
    let server_done = Arc::new(Mutex::new(false));
    let server_done_clone = Arc::clone(&server_done);

    let introspect = ctx.introspect();
    introspect.get_server_info(move |info| {
        if let Some(ref name) = info.default_source_name {
            if let Ok(mut guard) = default_source_clone.lock() {
                *guard = Some(name.to_string());
            }
        }
        if let Some(ref name) = info.default_sink_name {
            if let Ok(mut guard) = default_sink_clone.lock() {
                *guard = Some(name.to_string());
            }
        }
        if let Ok(mut done) = server_done_clone.lock() {
            *done = true;
        }
    });

    // Wait for server info callback
    loop {
        if let Ok(done) = server_done.lock() {
            if *done {
                break;
            }
        }
        match ml.iterate(true) {
            pulse::mainloop::standard::IterateResult::Quit(_)
            | pulse::mainloop::standard::IterateResult::Err(_) => break,
            _ => {}
        }
    }

    let default_name = default_source
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_default();
    let default_sink_name = default_sink.lock().ok().and_then(|g| g.clone());

    // Enumerate sources
    let sources: Arc<Mutex<Vec<PulseSource>>> = Arc::new(Mutex::new(Vec::new()));
    let sources_clone = Arc::clone(&sources);
    let default_name_clone = default_name.clone();
    let list_done = Arc::new(Mutex::new(false));
    let list_done_clone = Arc::clone(&list_done);

    introspect.get_source_info_list(move |result| match result {
        pulse::callbacks::ListResult::Item(info) => {
            let name = info
                .name
                .as_ref()
                .map(|n| n.to_string())
                .unwrap_or_default();
            let description = info
                .description
                .as_ref()
                .map(|d| d.to_string())
                .unwrap_or_else(|| name.clone());
            let is_monitor = info.monitor_of_sink.is_some();
            let is_default_sink_monitor = is_monitor
                && default_sink_name.is_some()
                && info.monitor_of_sink_name.as_deref() == default_sink_name.as_deref();

            let sample_rate = info.sample_spec.rate;
            if let Ok(mut guard) = sources_clone.lock() {
                guard.push(PulseSource {
                    is_default: name == default_name_clone,
                    name,
                    description,
                    is_monitor,
                    is_default_sink_monitor,
                    sample_rate,
                });
            }
        }
        pulse::callbacks::ListResult::End | pulse::callbacks::ListResult::Error => {
            if let Ok(mut done) = list_done_clone.lock() {
                *done = true;
            }
        }
    });

    // Wait for source list callback
    loop {
        if let Ok(done) = list_done.lock() {
            if *done {
                break;
            }
        }
        match ml.iterate(true) {
            pulse::mainloop::standard::IterateResult::Quit(_)
            | pulse::mainloop::standard::IterateResult::Err(_) => break,
            _ => {}
        }
    }

    ctx.disconnect();

    match Arc::try_unwrap(sources) {
        Ok(mutex) => mutex.into_inner().unwrap_or_default(),
        Err(arc) => arc.lock().unwrap_or_else(|p| p.into_inner()).clone(),
    }
}

/// The monitor source of the default sink, if the server has one.
pub(crate) fn default_sink_monitor() -> Option<PulseSource> {
    enumerate_pulse_sources()
        .into_iter()
        .find(|source| source.is_default_sink_monitor)
}

/// List microphone sources via PulseAudio, filtering out monitors.
/// Returns descriptors compatible with the existing UI.
pub fn list_pulse_input_devices() -> Vec<InputDeviceDescriptor> {
    let sources = enumerate_pulse_sources();

    let mut devices: Vec<InputDeviceDescriptor> = sources
        .into_iter()
        .filter(|s| !s.is_monitor)
        .map(|s| InputDeviceDescriptor {
            label: s.description,
            is_default: s.is_default,
            caution: false,
        })
        .collect();

    // Sort: default first, then alphabetical
    devices.sort_by(|a, b| {
        b.is_default.cmp(&a.is_default).then_with(|| {
            a.label
                .to_ascii_lowercase()
                .cmp(&b.label.to_ascii_lowercase())
        })
    });

    devices
}
