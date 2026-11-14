//! Meeting capture: records the microphone, mixed with system audio when the
//! platform allows it, into meeting audio segments. The microphone uses a
//! dedicated recorder instance, independent of dictation (its own device
//! stream, state and lock); system audio comes from its own source and only
//! ever adds to the microphone's timeline (see `meeting_mixer`).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use crate::platform::system_audio::{
    SystemAudioChunk, SystemAudioChunkCallback, SystemAudioSource, SystemAudioState,
    SystemAudioStateCallback,
};
use crate::platform::{ChunkCallback, Recorder};
use crate::system::meeting_audio::{rms_level, samples_to_ms, SegmentWriter, MEETING_SAMPLE_RATE};
use crate::system::meeting_mixer::MeetingMixer;

pub const EVT_MEETING_CAPTURE_PROGRESS: &str = "meeting_capture_progress";

/// How long the writer waits for audio before looking at its stop and roll
/// flags again. A stop takes at most this long to be noticed.
const RECEIVE_TIMEOUT: Duration = Duration::from_millis(20);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
const COMMIT_INTERVAL: Duration = Duration::from_secs(1);
const SILENT_DEVICE_TIMEOUT: Duration = Duration::from_secs(3);
const ROLL_TIMEOUT: Duration = Duration::from_secs(10);
/// Chunks (about 100 ms each) queued for the writer. A disk that stalls
/// longer than this fills the queue: the capture is marked write-failed
/// (the app pauses it) instead of buffering without limit or dropping audio.
const CHUNK_QUEUE_CAPACITY: usize = 300;
/// System audio buffers (about 10 ms each) queued for the writer. When full,
/// system audio is skipped; it never counts against the microphone.
const SYSTEM_QUEUE_CAPACITY: usize = 1_000;
/// A source that delivers silence while nothing plays and has delivered
/// nothing for this long has stalled.
const SYSTEM_STALL_TIMEOUT: Duration = Duration::from_secs(3);
/// Input below this level for this long is reported as "no audio detected"
/// (a muted or permission-blocked microphone delivers digital silence).
const SILENCE_LEVEL: f32 = 1e-4;
const SILENCE_WARNING_AFTER: Duration = Duration::from_secs(15);
/// The device's delivery rate is checked over this window; a rate this far
/// from the stream's configured rate means the device changed its format
/// underneath the stream (a call app or a Bluetooth headset switching it),
/// which would otherwise shift the recording's pitch and duration.
const RATE_CHECK_WINDOW: Duration = Duration::from_secs(5);
const RATE_TOLERANCE: f64 = 0.05;

/// Why a capture stopped receiving audio. Everything captured so far is on disk.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureInterruption {
    /// The device stopped delivering audio (unplugged, stream died).
    NoAudio,
    /// Audio could not be written (disk full, permissions, a stalled disk).
    WriteFailed,
    /// The device started delivering audio at another rate; the app
    /// restarts the capture so the recording stays true to time.
    DeviceChanged,
}

impl CaptureInterruption {
    fn code(self) -> u32 {
        match self {
            Self::NoAudio => 1,
            Self::WriteFailed => 2,
            Self::DeviceChanged => 3,
        }
    }

    fn from_code(code: u32) -> Option<Self> {
        match code {
            1 => Some(Self::NoAudio),
            2 => Some(Self::WriteFailed),
            3 => Some(Self::DeviceChanged),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MeetingCaptureStatus {
    pub note_id: String,
    pub segment_id: String,
    pub audio_path: String,
    /// The whole segment file, including audio it had before this capture.
    pub duration_ms: u64,
    /// What the segment file held when this capture started appending to it.
    pub initial_duration_ms: u64,
    pub level: f32,
    pub interruption: Option<CaptureInterruption>,
    /// Only silence has arrived from the microphone for a while (muted,
    /// blocked or wrong microphone).
    pub silent: bool,
    /// Whether the computer's audio is mixed in, and if not, why.
    pub system_audio: SystemAudioState,
}

#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MeetingCaptureStopped {
    pub note_id: String,
    pub segment_id: String,
    pub audio_path: String,
    pub duration_ms: u64,
}

#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MeetingCaptureRolled {
    pub finished: MeetingCaptureStopped,
    pub status: MeetingCaptureStatus,
}

struct SegmentTarget {
    segment_id: String,
    audio_path: PathBuf,
    initial_samples: u64,
}

#[derive(Default)]
struct CaptureShared {
    samples_written: AtomicU64,
    level_bits: AtomicU32,
    interruption: AtomicU32,
    silent: AtomicBool,
    /// As the system audio source last reported it.
    system_state: AtomicU32,
    system_chunks: AtomicU64,
    /// The source reports recording but has delivered nothing for a while.
    system_stalled: AtomicBool,
    system_delivers_silence: bool,
    stop: AtomicBool,
    /// The writer has finished; the progress monitor ends.
    finished: AtomicBool,
    /// The segment being written. Only the writer changes it (when it
    /// switches files), so it always names the file audio is going to.
    target: Mutex<Option<SegmentTarget>>,
    /// A segment switch waiting for the writer to pick it up.
    roll: Mutex<Option<RollRequest>>,
}

impl CaptureShared {
    fn interrupt(&self, reason: CaptureInterruption) {
        let _ = self.interruption.compare_exchange(
            0,
            reason.code(),
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
    }

    fn interruption(&self) -> Option<CaptureInterruption> {
        CaptureInterruption::from_code(self.interruption.load(Ordering::SeqCst))
    }

    fn system_audio(&self) -> SystemAudioState {
        match SystemAudioState::from_code(self.system_state.load(Ordering::SeqCst)) {
            SystemAudioState::Recording if self.system_stalled.load(Ordering::Relaxed) => {
                SystemAudioState::Failed
            }
            state => state,
        }
    }

    fn status(&self, note_id: &str) -> MeetingCaptureStatus {
        let target = self.target.lock().unwrap_or_else(|p| p.into_inner());
        let (segment_id, audio_path, initial_samples) = target
            .as_ref()
            .map(|t| {
                (
                    t.segment_id.clone(),
                    t.audio_path.clone(),
                    t.initial_samples,
                )
            })
            .unwrap_or_default();
        MeetingCaptureStatus {
            note_id: note_id.to_string(),
            segment_id,
            audio_path: audio_path.to_string_lossy().to_string(),
            duration_ms: samples_to_ms(self.samples_written.load(Ordering::Relaxed)),
            initial_duration_ms: samples_to_ms(initial_samples),
            level: f32::from_bits(self.level_bits.load(Ordering::Relaxed)),
            interruption: self.interruption(),
            silent: self.silent.load(Ordering::Relaxed),
            system_audio: self.system_audio(),
        }
    }
}

/// Microphone audio and when it reached the capture.
struct MicrophoneChunk {
    at: Instant,
    samples: Vec<f32>,
}

/// System audio and when it reached the capture.
struct SystemChunk {
    at: Instant,
    audio: SystemAudioChunk,
}

/// Swaps the writer thread onto a new segment file between two chunks.
struct RollRequest {
    writer: SegmentWriter,
    target: SegmentTarget,
    /// The finished segment's sample count, sent once the switch happened.
    reply: Sender<u64>,
}

struct ActiveCapture {
    note_id: String,
    shared: Arc<CaptureShared>,
    writer_thread: JoinHandle<std::io::Result<u64>>,
    monitor_thread: JoinHandle<()>,
}

/// Hands a segment switch to the writer and waits for it. If the writer does
/// not pick it up in time (a stalled disk), the request is withdrawn, so the
/// capture stays on its current file and nothing refers to the new one.
fn submit_roll(
    shared: &CaptureShared,
    request: RollRequest,
    reply: &Receiver<u64>,
    timeout: Duration,
) -> Result<u64, String> {
    *shared.roll.lock().unwrap_or_else(|p| p.into_inner()) = Some(request);
    match reply.recv_timeout(timeout) {
        Ok(samples) => Ok(samples),
        Err(_) => {
            let withdrawn = shared.roll.lock().unwrap_or_else(|p| p.into_inner()).take();
            match withdrawn {
                Some(request) => {
                    let path = request.target.audio_path.clone();
                    drop(request);
                    let _ = crate::system::meeting_audio::delete_segment(&path);
                    Err("The meeting capture did not switch segments".to_string())
                }
                // Picked up just as the wait ended: the switch happened.
                None => reply
                    .recv()
                    .map_err(|_| "The meeting capture has stopped".to_string()),
            }
        }
    }
}

fn open_writer(path: &Path, append: bool) -> std::io::Result<SegmentWriter> {
    if append {
        SegmentWriter::open_append(path)
    } else {
        SegmentWriter::create(path)
    }
}

pub struct MeetingCapture {
    recorder: Arc<dyn Recorder>,
    system: Arc<dyn SystemAudioSource>,
    active: Mutex<Option<ActiveCapture>>,
}

impl Default for MeetingCapture {
    fn default() -> Self {
        Self::new()
    }
}

impl MeetingCapture {
    pub fn new() -> Self {
        Self::with_sources(
            crate::platform::audio::new_streaming_recorder(),
            crate::platform::system_audio::new_system_audio_source(),
        )
    }

    fn with_sources(recorder: Arc<dyn Recorder>, system: Arc<dyn SystemAudioSource>) -> Self {
        Self {
            recorder,
            system,
            active: Mutex::new(None),
        }
    }

    fn active(&self) -> std::sync::MutexGuard<'_, Option<ActiveCapture>> {
        self.active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn status(&self) -> Option<MeetingCaptureStatus> {
        self.active()
            .as_ref()
            .map(|capture| capture.shared.status(&capture.note_id))
    }

    /// Starts capturing into `audio_path`: a new file, or (`append`) the end
    /// of an existing segment file.
    pub fn start(
        &self,
        app: &AppHandle,
        note_id: String,
        segment_id: String,
        audio_path: PathBuf,
        append: bool,
        preferred_microphone: Option<String>,
    ) -> Result<MeetingCaptureStatus, String> {
        let progress_app = app.clone();
        let progress_note_id = note_id.clone();
        self.start_with_progress(
            note_id,
            segment_id,
            audio_path,
            append,
            preferred_microphone,
            move |shared| {
                let status = shared.status(&progress_note_id);
                if let Err(err) = progress_app.emit(EVT_MEETING_CAPTURE_PROGRESS, status) {
                    log::error!("Failed to emit meeting capture progress: {err}");
                }
            },
        )
    }

    fn start_with_progress(
        &self,
        note_id: String,
        segment_id: String,
        audio_path: PathBuf,
        append: bool,
        preferred_microphone: Option<String>,
        emit_progress: impl Fn(&CaptureShared) + Send + 'static,
    ) -> Result<MeetingCaptureStatus, String> {
        let mut active = self.active();
        if active.is_some() {
            return Err("A meeting is already being recorded".to_string());
        }

        let writer = open_writer(&audio_path, append).map_err(|err| err.to_string())?;
        let initial_samples = writer.samples_written();

        let shared = Arc::new(CaptureShared {
            system_delivers_silence: self.system.delivers_silence(),
            ..CaptureShared::default()
        });
        let (sender, receiver) = mpsc::sync_channel::<MicrophoneChunk>(CHUNK_QUEUE_CAPACITY);
        let chunk_callback = queue_chunks(sender, Arc::clone(&shared));
        let (system_sender, system_receiver) =
            mpsc::sync_channel::<SystemChunk>(SYSTEM_QUEUE_CAPACITY);

        self.recorder
            .set_preferred_input_device(preferred_microphone);
        if let Err(err) = self.recorder.start(None, Some(chunk_callback)) {
            drop(writer);
            if !append {
                let _ = crate::system::meeting_audio::delete_segment(&audio_path);
            }
            return Err(err.to_string());
        }
        let input_rate = self
            .recorder
            .current_sample_rate()
            .unwrap_or(MEETING_SAMPLE_RATE);

        shared
            .samples_written
            .store(initial_samples, Ordering::SeqCst);
        *shared.target.lock().unwrap_or_else(|p| p.into_inner()) = Some(SegmentTarget {
            segment_id,
            audio_path,
            initial_samples,
        });
        let thread_shared = Arc::clone(&shared);
        let writer_thread = std::thread::Builder::new()
            .name("meeting-capture-writer".into())
            .spawn(move || {
                run_writer(
                    writer,
                    receiver,
                    system_receiver,
                    input_rate,
                    &thread_shared,
                )
            })
            .map_err(|err| {
                let _ = self.recorder.stop();
                err.to_string()
            })?;
        // Progress comes from its own thread, so a writer stuck on a stalled
        // disk still reports (and the app can pause the capture).
        let monitor_shared = Arc::clone(&shared);
        let monitor_thread = std::thread::Builder::new()
            .name("meeting-capture-progress".into())
            .spawn(move || {
                while !monitor_shared.finished.load(Ordering::SeqCst) {
                    emit_progress(&monitor_shared);
                    // Parked, not asleep, so `stop` can wake it at once.
                    std::thread::park_timeout(PROGRESS_INTERVAL);
                }
                emit_progress(&monitor_shared);
            })
            .map_err(|err| {
                let _ = self.recorder.stop();
                err.to_string()
            })?;

        // Started last and never waited for: the microphone is already
        // recording, and system audio joins whenever it is ready (after a
        // permission prompt, say) or not at all.
        self.system.start(
            queue_system_chunks(system_sender, Arc::clone(&shared)),
            track_system_state(Arc::clone(&shared)),
        );

        log::info!("Meeting capture started (input rate {input_rate} Hz)");
        let capture = ActiveCapture {
            note_id,
            shared,
            writer_thread,
            monitor_thread,
        };
        let status = capture.shared.status(&capture.note_id);
        *active = Some(capture);
        Ok(status)
    }

    /// Continues the running capture in a new segment file with no gap: the
    /// writer switches files between two chunks of audio.
    pub fn roll(
        &self,
        segment_id: String,
        audio_path: PathBuf,
    ) -> Result<MeetingCaptureRolled, String> {
        self.roll_within(segment_id, audio_path, ROLL_TIMEOUT)
    }

    fn roll_within(
        &self,
        segment_id: String,
        audio_path: PathBuf,
        timeout: Duration,
    ) -> Result<MeetingCaptureRolled, String> {
        let active = self.active();
        let capture = active
            .as_ref()
            .ok_or_else(|| "No meeting is being recorded".to_string())?;

        let writer = SegmentWriter::create(&audio_path).map_err(|err| err.to_string())?;
        let previous = {
            let target = capture
                .shared
                .target
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            target
                .as_ref()
                .map(|t| (t.segment_id.clone(), t.audio_path.clone()))
                .unwrap_or_default()
        };
        let (reply, finished) = mpsc::channel();
        let samples = submit_roll(
            &capture.shared,
            RollRequest {
                writer,
                target: SegmentTarget {
                    segment_id,
                    audio_path,
                    initial_samples: 0,
                },
                reply,
            },
            &finished,
            timeout,
        )?;
        Ok(MeetingCaptureRolled {
            finished: MeetingCaptureStopped {
                note_id: capture.note_id.clone(),
                segment_id: previous.0,
                audio_path: previous.1.to_string_lossy().to_string(),
                duration_ms: samples_to_ms(samples),
            },
            status: capture.shared.status(&capture.note_id),
        })
    }

    pub fn stop(&self) -> Result<Option<MeetingCaptureStopped>, String> {
        let Some(capture) = self.active().take() else {
            return Ok(None);
        };

        let started = Instant::now();
        // The recorder stops (and hands over what it buffered) before the
        // writer is told to finish, so the last moments are kept.
        if let Err(err) = self.recorder.stop() {
            log::warn!("Meeting recorder stop reported: {err}");
        }
        self.system.stop();
        capture.shared.stop.store(true, Ordering::SeqCst);

        let samples = match capture.writer_thread.join() {
            Ok(Ok(samples)) => samples,
            Ok(Err(err)) => {
                log::error!("Meeting segment finalize failed: {err}");
                capture.shared.samples_written.load(Ordering::SeqCst)
            }
            Err(_) => {
                log::error!("Meeting capture writer panicked");
                capture.shared.samples_written.load(Ordering::SeqCst)
            }
        };

        capture.monitor_thread.thread().unpark();
        let _ = capture.monitor_thread.join();
        log::info!(
            "Meeting capture stopped ({} ms of audio) in {} ms",
            samples_to_ms(samples),
            started.elapsed().as_millis()
        );
        let status = capture.shared.status(&capture.note_id);
        Ok(Some(MeetingCaptureStopped {
            note_id: capture.note_id,
            segment_id: status.segment_id,
            audio_path: status.audio_path,
            duration_ms: samples_to_ms(samples),
        }))
    }
}

/// The audio callback's side of the queue: never blocks the device thread.
fn queue_chunks(sender: SyncSender<MicrophoneChunk>, shared: Arc<CaptureShared>) -> ChunkCallback {
    Arc::new(move |samples: Vec<f32>| {
        let chunk = MicrophoneChunk {
            at: Instant::now(),
            samples,
        };
        if let Err(TrySendError::Full(_)) = sender.try_send(chunk) {
            shared.interrupt(CaptureInterruption::WriteFailed);
        }
    })
}

/// Like `queue_chunks`, except that a full queue only skips system audio.
fn queue_system_chunks(
    sender: SyncSender<SystemChunk>,
    shared: Arc<CaptureShared>,
) -> SystemAudioChunkCallback {
    let overflow_logged = AtomicBool::new(false);
    Arc::new(move |audio: SystemAudioChunk| {
        shared.system_chunks.fetch_add(1, Ordering::Relaxed);
        let chunk = SystemChunk {
            at: Instant::now(),
            audio,
        };
        if let Err(TrySendError::Full(_)) = sender.try_send(chunk) {
            if !overflow_logged.swap(true, Ordering::Relaxed) {
                log::warn!("Meeting system audio queue is full; skipping system audio");
            }
        }
    })
}

fn track_system_state(shared: Arc<CaptureShared>) -> SystemAudioStateCallback {
    Arc::new(move |state: SystemAudioState| {
        let previous = shared.system_state.swap(state.code(), Ordering::SeqCst);
        if previous != state.code() {
            log::info!("Meeting system audio: {state:?}");
        }
    })
}

/// System audio waiting to be mixed, handed to the mixer in arrival order.
struct SystemFeed {
    receiver: Receiver<SystemChunk>,
    /// The first chunk that arrived after the microphone audio mixed so far.
    pending: Option<SystemChunk>,
}

impl SystemFeed {
    fn feed_until(&mut self, until: Instant, mixer: &mut MeetingMixer) {
        loop {
            let Some(chunk) = self
                .pending
                .take()
                .or_else(|| self.receiver.try_recv().ok())
            else {
                return;
            };
            if chunk.at > until {
                self.pending = Some(chunk);
                return;
            }
            mixer.push_system(&chunk.audio.samples, chunk.audio.sample_rate);
        }
    }
}

/// Notices a source that says it is recording but has stopped delivering.
struct SystemStallWatch {
    chunks: u64,
    progressed_at: Instant,
}

impl SystemStallWatch {
    fn new() -> Self {
        Self {
            chunks: 0,
            progressed_at: Instant::now(),
        }
    }

    fn check(&mut self, shared: &CaptureShared, now: Instant) {
        let chunks = shared.system_chunks.load(Ordering::Relaxed);
        let recording = SystemAudioState::from_code(shared.system_state.load(Ordering::SeqCst))
            == SystemAudioState::Recording;
        if chunks != self.chunks || !recording {
            self.chunks = chunks;
            self.progressed_at = now;
        }
        let stalled = shared.system_delivers_silence
            && recording
            && now.duration_since(self.progressed_at) >= SYSTEM_STALL_TIMEOUT;
        shared.system_stalled.store(stalled, Ordering::Relaxed);
    }
}

/// Measures how fast the device actually delivers samples.
struct RateCheck {
    expected: f64,
    started: Option<Instant>,
    delivered: u64,
}

impl RateCheck {
    fn new(expected: u32) -> Self {
        Self {
            expected: expected as f64,
            started: None,
            delivered: 0,
        }
    }

    /// Whether the delivery rate over the last window is off the configured rate.
    fn changed(&mut self, samples: usize, now: Instant) -> bool {
        let started = *self.started.get_or_insert(now);
        let elapsed = now.duration_since(started);
        if elapsed >= RATE_CHECK_WINDOW {
            let measured = self.delivered as f64 / elapsed.as_secs_f64();
            self.started = Some(now);
            self.delivered = samples as u64;
            return (measured - self.expected).abs() / self.expected > RATE_TOLERANCE;
        }
        self.delivered += samples as u64;
        false
    }
}

fn run_writer(
    mut writer: SegmentWriter,
    receiver: Receiver<MicrophoneChunk>,
    system: Receiver<SystemChunk>,
    input_rate: u32,
    shared: &CaptureShared,
) -> std::io::Result<u64> {
    let mut mixer = MeetingMixer::new(input_rate);
    let mut system = SystemFeed {
        receiver: system,
        pending: None,
    };
    let mut stall_watch = SystemStallWatch::new();
    let mut converted = Vec::new();
    let mut rate_check = RateCheck::new(input_rate);
    let mut last_audio = Instant::now();
    let mut silent_samples: u64 = 0;
    let silence_warning_samples = SILENCE_WARNING_AFTER.as_secs() * u64::from(input_rate.max(1));
    let mut last_commit = Instant::now();

    let mut write = |chunk: &MicrophoneChunk, writer: &mut SegmentWriter| -> std::io::Result<()> {
        let samples = chunk.samples.as_slice();
        let level = rms_level(samples);
        shared.level_bits.store(level.to_bits(), Ordering::Relaxed);
        if level < SILENCE_LEVEL {
            silent_samples += samples.len() as u64;
            if silent_samples >= silence_warning_samples {
                shared.silent.store(true, Ordering::Relaxed);
            }
        } else {
            silent_samples = 0;
            shared.silent.store(false, Ordering::Relaxed);
        }
        if rate_check.changed(samples.len(), Instant::now()) {
            log::warn!("Meeting input rate no longer matches {input_rate} Hz");
            shared.interrupt(CaptureInterruption::DeviceChanged);
        }
        system.feed_until(chunk.at, &mut mixer);
        converted.clear();
        mixer.mix_microphone(samples, &mut converted);
        writer.append(&converted)?;
        shared
            .samples_written
            .store(writer.samples_written(), Ordering::Relaxed);
        Ok(())
    };

    let result = loop {
        let roll = shared.roll.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(RollRequest {
            writer: next,
            target,
            reply,
        }) = roll
        {
            let finished_samples = writer.samples_written();
            let finished = std::mem::replace(&mut writer, next);
            *shared.target.lock().unwrap_or_else(|p| p.into_inner()) = Some(target);
            shared.samples_written.store(0, Ordering::SeqCst);
            let _ = reply.send(finished_samples);
            if let Err(err) = finished.finish() {
                // The audio is on disk; its header is repaired when read.
                log::error!("Finishing a rolled meeting segment failed: {err}");
            }
        }

        match receiver.recv_timeout(RECEIVE_TIMEOUT) {
            Ok(chunk) => {
                if let Err(err) = write(&chunk, &mut writer) {
                    break Err(err);
                }
                last_audio = Instant::now();
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                if !shared.stop.load(Ordering::SeqCst) {
                    shared.interrupt(CaptureInterruption::NoAudio);
                }
                break Ok(());
            }
        }

        if shared.stop.load(Ordering::SeqCst) {
            let drained: Result<(), std::io::Error> = receiver
                .try_iter()
                .try_for_each(|chunk| write(&chunk, &mut writer));
            break drained;
        }

        stall_watch.check(shared, Instant::now());

        if last_audio.elapsed() >= SILENT_DEVICE_TIMEOUT {
            shared.interrupt(CaptureInterruption::NoAudio);
        }

        if last_commit.elapsed() >= COMMIT_INTERVAL {
            if let Err(err) = writer.commit() {
                break Err(err);
            }
            last_commit = Instant::now();
        }
    };

    let result = result.and_then(|()| {
        converted.clear();
        mixer.flush(&mut converted);
        writer.append(&converted)
    });
    if let Err(err) = &result {
        log::error!("Meeting capture write failed: {err}");
        shared.interrupt(CaptureInterruption::WriteFailed);
    }
    let finished = writer.finish();
    shared.finished.store(true, Ordering::SeqCst);
    finished
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{RecordedAudio, RecordingMetrics, RecordingResult};
    use crate::platform::LevelCallback;

    fn microphone_chunk(samples: Vec<f32>) -> MicrophoneChunk {
        MicrophoneChunk {
            at: Instant::now(),
            samples,
        }
    }

    /// A system audio queue whose source is gone, as when none ever started.
    fn no_system() -> Receiver<SystemChunk> {
        mpsc::channel().1
    }

    fn temp_path(name: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "voquill-meeting-capture-{}-{name}.wav",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        path
    }

    #[test]
    fn writer_marks_a_vanished_source_as_interrupted_and_keeps_audio() {
        let path = temp_path("vanished");
        let writer = SegmentWriter::create(&path).unwrap();
        let (sender, receiver) = mpsc::channel();
        sender
            .send(microphone_chunk(vec![0.25f32; 48_000]))
            .unwrap();
        drop(sender);

        let shared = CaptureShared::default();
        let samples = run_writer(writer, receiver, no_system(), 48_000, &shared).unwrap();

        assert_eq!(samples, 16_000);
        assert_eq!(shared.interruption(), Some(CaptureInterruption::NoAudio));
        assert_eq!(
            crate::system::meeting_audio::repair_segment(&path).unwrap(),
            16_000
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn writer_drains_queued_audio_when_stopped() {
        let path = temp_path("stopped");
        let writer = SegmentWriter::create(&path).unwrap();
        let (sender, receiver) = mpsc::channel();
        let shared = CaptureShared::default();
        shared.stop.store(true, Ordering::SeqCst);
        for _ in 0..3 {
            sender.send(microphone_chunk(vec![0.1f32; 16_000])).unwrap();
        }

        let samples = run_writer(writer, receiver, no_system(), 16_000, &shared).unwrap();

        assert_eq!(samples, 48_000);
        assert_eq!(shared.interruption(), None);
        drop(sender);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_roll_the_writer_never_picks_up_is_withdrawn() {
        let path = temp_path("withdrawn");
        let shared = CaptureShared::default();
        *shared.target.lock().unwrap() = Some(SegmentTarget {
            segment_id: "a".into(),
            audio_path: temp_path("current"),
            initial_samples: 0,
        });
        let (reply, finished) = mpsc::channel();
        let result = submit_roll(
            &shared,
            RollRequest {
                writer: SegmentWriter::create(&path).unwrap(),
                target: SegmentTarget {
                    segment_id: "b".into(),
                    audio_path: path.clone(),
                    initial_samples: 0,
                },
                reply,
            },
            &finished,
            Duration::from_millis(50),
        );
        assert!(result.is_err());
        assert!(shared.roll.lock().unwrap().is_none());
        assert_eq!(
            shared.target.lock().unwrap().as_ref().unwrap().segment_id,
            "a",
            "the capture keeps tracking the file it writes"
        );
        assert!(!path.exists(), "the unused file is removed");
    }

    #[test]
    fn a_full_queue_marks_the_capture_write_failed_instead_of_growing() {
        let shared = Arc::new(CaptureShared::default());
        let (sender, _receiver) = mpsc::sync_channel(2);
        let callback = queue_chunks(sender, Arc::clone(&shared));
        for _ in 0..3 {
            callback(vec![0.1; 1_600]);
        }
        assert_eq!(
            shared.interruption(),
            Some(CaptureInterruption::WriteFailed)
        );
    }

    #[test]
    fn a_delivery_rate_off_the_configured_rate_is_a_device_change() {
        let start = Instant::now();
        let mut steady = RateCheck::new(48_000);
        let mut switched = RateCheck::new(48_000);
        let mut steady_changed = false;
        let mut switched_changed = false;
        for tick in 0..=60u64 {
            let now = start + Duration::from_millis(tick * 100);
            steady_changed |= steady.changed(4_800, now);
            // A Bluetooth headset switching to 16 kHz.
            switched_changed |= switched.changed(1_600, now);
        }
        assert!(!steady_changed);
        assert!(switched_changed);
    }

    #[test]
    fn sustained_digital_silence_is_reported() {
        let path = temp_path("silent");
        let writer = SegmentWriter::create(&path).unwrap();
        let (sender, receiver) = mpsc::channel();
        for _ in 0..160 {
            sender.send(microphone_chunk(vec![0.0f32; 1_600])).unwrap();
        }
        drop(sender);
        let shared = CaptureShared::default();
        run_writer(writer, receiver, no_system(), 16_000, &shared).unwrap();
        assert!(shared.silent.load(Ordering::SeqCst));
        std::fs::remove_file(path).unwrap();
    }

    const MICROPHONE_LEVEL: f32 = 0.2;
    /// Wall time between the fakes' 100 ms chunks: they run 50 times faster
    /// than real time, both at the same pace so their audio lines up.
    const FAST_PACE: Duration = Duration::from_millis(2);

    /// A recorder that delivers `chunks` of 16 kHz audio (100 ms each, every
    /// `pace`) from a thread, the way the platform recorders call the chunk
    /// callback.
    struct FakeRecorder {
        chunks: usize,
        pace: Duration,
        thread: Mutex<Option<JoinHandle<()>>>,
        stop: Arc<AtomicBool>,
    }

    impl Recorder for FakeRecorder {
        fn start(
            &self,
            _level: Option<LevelCallback>,
            chunk: Option<ChunkCallback>,
        ) -> Result<(), Box<dyn std::error::Error>> {
            let chunk = chunk.unwrap();
            let chunks = self.chunks;
            let pace = self.pace;
            let stop = Arc::clone(&self.stop);
            stop.store(false, Ordering::SeqCst);
            *self.thread.lock().unwrap() = Some(std::thread::spawn(move || {
                for _ in 0..chunks {
                    if stop.load(Ordering::SeqCst) {
                        return;
                    }
                    chunk(vec![MICROPHONE_LEVEL; 1_600]);
                    std::thread::sleep(pace);
                }
                while !stop.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(2));
                }
            }));
            Ok(())
        }

        fn stop(&self) -> Result<RecordingResult, Box<dyn std::error::Error>> {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(thread) = self.thread.lock().unwrap().take() {
                thread.join().unwrap();
            }
            Ok(RecordingResult {
                metrics: RecordingMetrics {
                    duration: Duration::ZERO,
                    size_bytes: 0,
                },
                audio: RecordedAudio {
                    samples: Vec::new(),
                    sample_rate: MEETING_SAMPLE_RATE,
                },
            })
        }

        fn current_sample_rate(&self) -> Option<u32> {
            Some(MEETING_SAMPLE_RATE)
        }
    }

    fn fake_recorder(chunks: usize, pace: Duration) -> Arc<FakeRecorder> {
        Arc::new(FakeRecorder {
            chunks,
            pace,
            thread: Mutex::new(None),
            stop: Arc::new(AtomicBool::new(false)),
        })
    }

    fn fake_capture(chunks: usize) -> MeetingCapture {
        MeetingCapture::with_sources(
            fake_recorder(chunks, FAST_PACE),
            FakeSystemSource::new(&[], FAST_PACE),
        )
    }

    /// What a fake system source does, step by step, once started.
    #[derive(Clone, Copy)]
    enum SystemStep {
        State(SystemAudioState),
        /// Delivers this many 100 ms buffers of a constant, at 48 kHz.
        Audio(usize, f32),
        /// Delivers nothing for this long.
        Quiet(Duration),
    }

    /// A system source that plays `steps` from a thread (a buffer every
    /// `pace`) and, once they are done, idles until stopped.
    struct FakeSystemSource {
        steps: Vec<SystemStep>,
        pace: Duration,
        stop: Arc<AtomicBool>,
        started: AtomicU32,
    }

    impl FakeSystemSource {
        fn new(steps: &[SystemStep], pace: Duration) -> Arc<Self> {
            Arc::new(Self {
                steps: steps.to_vec(),
                pace,
                stop: Arc::new(AtomicBool::new(false)),
                started: AtomicU32::new(0),
            })
        }
    }

    impl SystemAudioSource for FakeSystemSource {
        fn start(&self, on_chunk: SystemAudioChunkCallback, on_state: SystemAudioStateCallback) {
            self.started.fetch_add(1, Ordering::SeqCst);
            self.stop.store(false, Ordering::SeqCst);
            let steps = self.steps.clone();
            let pace = self.pace;
            let stop = Arc::clone(&self.stop);
            std::thread::spawn(move || {
                for step in steps {
                    if stop.load(Ordering::SeqCst) {
                        return;
                    }
                    match step {
                        SystemStep::State(state) => on_state(state),
                        SystemStep::Audio(buffers, value) => {
                            for _ in 0..buffers {
                                if stop.load(Ordering::SeqCst) {
                                    return;
                                }
                                on_chunk(SystemAudioChunk {
                                    samples: vec![value; 4_800],
                                    sample_rate: 48_000,
                                });
                                std::thread::sleep(pace);
                            }
                        }
                        SystemStep::Quiet(duration) => std::thread::sleep(duration),
                    }
                }
            });
        }

        fn stop(&self) {
            self.stop.store(true, Ordering::SeqCst);
        }

        fn delivers_silence(&self) -> bool {
            true
        }
    }

    fn wait_for(condition: impl Fn() -> bool) {
        wait_within(Duration::from_secs(5), condition);
    }

    fn wait_within(timeout: Duration, condition: impl Fn() -> bool) {
        let deadline = Instant::now() + timeout;
        while !condition() {
            assert!(
                Instant::now() < deadline,
                "timed out after {timeout:?} waiting for the capture"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn read_samples(path: &Path) -> Vec<f32> {
        crate::system::meeting_audio::repair_segment(path).unwrap();
        hound::WavReader::open(path)
            .unwrap()
            .samples::<i16>()
            .map(|sample| sample.unwrap() as f32 / i16::MAX as f32)
            .collect()
    }

    /// The share of samples at `level` (microphone alone, or with system audio).
    fn share_at(samples: &[f32], level: f32) -> f64 {
        samples
            .iter()
            .filter(|sample| (**sample - level).abs() < 0.01)
            .count() as f64
            / samples.len() as f64
    }

    #[test]
    fn rolls_to_a_new_segment_without_losing_audio() {
        let first = temp_path("roll-a");
        let second = temp_path("roll-b");
        let capture = fake_capture(100);
        capture
            .start_with_progress("n".into(), "a".into(), first.clone(), false, None, |_| {})
            .unwrap();
        wait_for(|| capture.status().unwrap().duration_ms >= 1_000);

        let rolled = capture.roll("b".into(), second.clone()).unwrap();
        assert_eq!(rolled.finished.segment_id, "a");
        assert_eq!(rolled.status.segment_id, "b");
        wait_for(|| capture.status().unwrap().duration_ms + rolled.finished.duration_ms >= 10_000);
        let stopped = capture.stop().unwrap().unwrap();

        assert_eq!(stopped.segment_id, "b");
        let total = crate::system::meeting_audio::repair_segment(&first).unwrap()
            + crate::system::meeting_audio::repair_segment(&second).unwrap();
        assert_eq!(
            total,
            100 * 1_600,
            "every delivered sample is in one of the files"
        );
        std::fs::remove_file(first).unwrap();
        std::fs::remove_file(second).unwrap();
    }

    #[test]
    fn stop_does_not_wait_out_the_progress_interval() {
        let path = temp_path("prompt-stop");
        let capture = fake_capture(10);
        capture
            .start_with_progress("n".into(), "a".into(), path.clone(), false, None, |_| {})
            .unwrap();
        wait_for(|| capture.status().unwrap().duration_ms >= 1_000);

        let started = Instant::now();
        let stopped = capture.stop().unwrap().unwrap();

        assert!(
            started.elapsed() < PROGRESS_INTERVAL / 2,
            "stop took {:?}",
            started.elapsed()
        );
        assert_eq!(stopped.duration_ms, 1_000);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn appends_to_an_existing_segment_on_resume() {
        let path = temp_path("append");
        let capture = fake_capture(10);
        capture
            .start_with_progress("n".into(), "a".into(), path.clone(), false, None, |_| {})
            .unwrap();
        wait_for(|| capture.status().unwrap().duration_ms >= 1_000);
        capture.stop().unwrap();

        let status = capture
            .start_with_progress("n".into(), "a".into(), path.clone(), true, None, |_| {})
            .unwrap();
        assert_eq!(status.initial_duration_ms, 1_000);
        wait_for(|| capture.status().unwrap().duration_ms >= 2_000);
        let stopped = capture.stop().unwrap().unwrap();

        assert_eq!(stopped.duration_ms, 2_000);
        assert_eq!(
            crate::system::meeting_audio::repair_segment(&path).unwrap(),
            32_000
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_second_recorder_starting_and_stopping_does_not_touch_the_meeting() {
        let path = temp_path("concurrent");
        let capture = fake_capture(50);
        capture
            .start_with_progress("n".into(), "a".into(), path.clone(), false, None, |_| {})
            .unwrap();
        let dictation = FakeRecorder {
            chunks: 5,
            pace: FAST_PACE,
            thread: Mutex::new(None),
            stop: Arc::new(AtomicBool::new(false)),
        };
        for _ in 0..3 {
            dictation.start(None, Some(Arc::new(|_| {}))).unwrap();
            dictation.stop().unwrap();
        }
        wait_for(|| capture.status().unwrap().duration_ms >= 5_000);
        let stopped = capture.stop().unwrap().unwrap();
        assert_eq!(stopped.duration_ms, 5_000);
        assert_eq!(capture.status().map(|s| s.duration_ms), None);
        std::fs::remove_file(path).unwrap();
    }

    const SYSTEM_LEVEL: f32 = 0.1;

    fn system_capture(
        chunks: usize,
        steps: &[SystemStep],
    ) -> (MeetingCapture, Arc<FakeSystemSource>) {
        let system = FakeSystemSource::new(steps, FAST_PACE);
        let capture = MeetingCapture::with_sources(
            fake_recorder(chunks, FAST_PACE),
            Arc::clone(&system) as Arc<dyn SystemAudioSource>,
        );
        (capture, system)
    }

    #[test]
    fn writer_mixes_queued_system_audio_and_drains_both_when_stopped() {
        let path = temp_path("mixed-drain");
        let writer = SegmentWriter::create(&path).unwrap();
        let (sender, receiver) = mpsc::channel();
        let (system_sender, system_receiver) = mpsc::channel();
        let shared = CaptureShared::default();
        shared.stop.store(true, Ordering::SeqCst);
        let start = Instant::now();
        for second in 0..3u64 {
            let at = start + Duration::from_secs(second);
            system_sender
                .send(SystemChunk {
                    at,
                    audio: SystemAudioChunk {
                        samples: vec![SYSTEM_LEVEL; 16_000],
                        sample_rate: 16_000,
                    },
                })
                .unwrap();
            sender
                .send(MicrophoneChunk {
                    at: at + Duration::from_millis(1),
                    samples: vec![MICROPHONE_LEVEL; 16_000],
                })
                .unwrap();
        }

        let samples = run_writer(writer, receiver, system_receiver, 16_000, &shared).unwrap();

        assert_eq!(samples, 48_000, "the microphone sets the length");
        let mixed = read_samples(&path);
        assert!(
            share_at(&mixed[1_000..], MICROPHONE_LEVEL + SYSTEM_LEVEL) > 0.99,
            "queued system audio is mixed in"
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn system_audio_is_mixed_into_the_segment() {
        let path = temp_path("system-mixed");
        let (capture, _) = system_capture(
            100,
            &[
                SystemStep::State(SystemAudioState::Recording),
                SystemStep::Audio(100, SYSTEM_LEVEL),
            ],
        );
        capture
            .start_with_progress("n".into(), "a".into(), path.clone(), false, None, |_| {})
            .unwrap();
        wait_for(|| capture.status().unwrap().system_audio == SystemAudioState::Recording);
        wait_for(|| capture.status().unwrap().duration_ms >= 10_000);
        let stopped = capture.stop().unwrap().unwrap();

        assert_eq!(stopped.duration_ms, 10_000);
        let mixed = read_samples(&path);
        assert_eq!(mixed.len(), 100 * 1_600);
        assert!(
            share_at(&mixed, MICROPHONE_LEVEL + SYSTEM_LEVEL) > 0.5,
            "most of the meeting has both sources"
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_system_source_that_cannot_start_leaves_the_microphone_recording() {
        for state in [
            SystemAudioState::Failed,
            SystemAudioState::Denied,
            SystemAudioState::Unsupported,
        ] {
            let path = temp_path("system-unavailable");
            let (capture, _) = system_capture(10, &[SystemStep::State(state)]);
            capture
                .start_with_progress("n".into(), "a".into(), path.clone(), false, None, |_| {})
                .unwrap();
            wait_for(|| capture.status().unwrap().duration_ms >= 1_000);
            assert_eq!(capture.status().unwrap().system_audio, state);
            let stopped = capture.stop().unwrap().unwrap();

            assert_eq!(stopped.duration_ms, 1_000);
            assert!(share_at(&read_samples(&path), MICROPHONE_LEVEL) > 0.999);
            std::fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn a_system_source_that_never_reports_is_pending_and_harmless() {
        let path = temp_path("system-pending");
        let capture = fake_capture(10);
        let status = capture
            .start_with_progress("n".into(), "a".into(), path.clone(), false, None, |_| {})
            .unwrap();
        assert_eq!(status.system_audio, SystemAudioState::Pending);
        wait_for(|| capture.status().unwrap().duration_ms >= 1_000);
        assert_eq!(capture.stop().unwrap().unwrap().duration_ms, 1_000);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_stalled_system_source_is_reported_and_recovers() {
        let pace = Duration::from_millis(20);
        let path = temp_path("system-stall");
        let system = FakeSystemSource::new(
            &[
                SystemStep::State(SystemAudioState::Recording),
                SystemStep::Audio(10, SYSTEM_LEVEL),
                SystemStep::Quiet(SYSTEM_STALL_TIMEOUT + Duration::from_millis(700)),
                SystemStep::Audio(100, SYSTEM_LEVEL),
            ],
            pace,
        );
        let capture = MeetingCapture::with_sources(fake_recorder(400, pace), system);
        capture
            .start_with_progress("n".into(), "a".into(), path.clone(), false, None, |_| {})
            .unwrap();
        wait_for(|| capture.status().unwrap().system_audio == SystemAudioState::Recording);
        wait_within(SYSTEM_STALL_TIMEOUT * 2, || {
            capture.status().unwrap().system_audio == SystemAudioState::Failed
        });
        assert_eq!(capture.status().unwrap().interruption, None);
        wait_within(SYSTEM_STALL_TIMEOUT, || {
            capture.status().unwrap().system_audio == SystemAudioState::Recording
        });
        let stopped = capture.stop().unwrap().unwrap();

        let samples = read_samples(&path);
        assert_eq!(samples.len() as u64, stopped.duration_ms * 16);
        assert!(
            share_at(&samples, MICROPHONE_LEVEL) > 0.3,
            "microphone alone in the stall"
        );
        assert!(
            share_at(&samples, MICROPHONE_LEVEL + SYSTEM_LEVEL) > 0.05,
            "both before and after it"
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn pause_and_resume_restart_the_system_source_and_keep_mixing() {
        let path = temp_path("system-resume");
        let steps = [
            SystemStep::State(SystemAudioState::Recording),
            SystemStep::Audio(1_000, SYSTEM_LEVEL),
        ];
        let (capture, system) = system_capture(10, &steps);
        capture
            .start_with_progress("n".into(), "a".into(), path.clone(), false, None, |_| {})
            .unwrap();
        wait_for(|| capture.status().unwrap().duration_ms >= 1_000);
        capture.stop().unwrap();

        let status = capture
            .start_with_progress("n".into(), "a".into(), path.clone(), true, None, |_| {})
            .unwrap();
        assert_eq!(status.initial_duration_ms, 1_000);
        wait_for(|| capture.status().unwrap().duration_ms >= 2_000);
        let stopped = capture.stop().unwrap().unwrap();

        assert_eq!(system.started.load(Ordering::SeqCst), 2);
        assert_eq!(stopped.duration_ms, 2_000);
        let samples = read_samples(&path);
        assert_eq!(samples.len(), 32_000);
        assert!(share_at(&samples[16_000..], MICROPHONE_LEVEL + SYSTEM_LEVEL) > 0.5);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn rolling_with_system_audio_loses_no_microphone_audio() {
        let first = temp_path("system-roll-a");
        let second = temp_path("system-roll-b");
        let (capture, _) = system_capture(
            100,
            &[
                SystemStep::State(SystemAudioState::Recording),
                SystemStep::Audio(1_000, SYSTEM_LEVEL),
            ],
        );
        capture
            .start_with_progress("n".into(), "a".into(), first.clone(), false, None, |_| {})
            .unwrap();
        wait_for(|| capture.status().unwrap().duration_ms >= 3_000);
        let rolled = capture.roll("b".into(), second.clone()).unwrap();
        wait_for(|| capture.status().unwrap().duration_ms + rolled.finished.duration_ms >= 10_000);
        capture.stop().unwrap();

        let before = read_samples(&first);
        let after = read_samples(&second);
        assert_eq!(before.len() + after.len(), 100 * 1_600);
        assert!(share_at(&before, MICROPHONE_LEVEL + SYSTEM_LEVEL) > 0.5);
        assert!(share_at(&after, MICROPHONE_LEVEL + SYSTEM_LEVEL) > 0.5);
        std::fs::remove_file(first).unwrap();
        std::fs::remove_file(second).unwrap();
    }
}
