//! Meeting capture: records the microphone into meeting audio segments on a
//! dedicated recorder instance, independent of dictation (its own device
//! stream, state and lock). The microphone is the only source today; another
//! source (system audio) would feed the same writer thread.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use crate::platform::{ChunkCallback, Recorder};
use crate::system::meeting_audio::{
    rms_level, samples_to_ms, Downsampler, SegmentWriter, MEETING_SAMPLE_RATE,
};

pub const EVT_MEETING_CAPTURE_PROGRESS: &str = "meeting_capture_progress";

const RECEIVE_TIMEOUT: Duration = Duration::from_millis(100);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
const COMMIT_INTERVAL: Duration = Duration::from_secs(1);
const SILENT_DEVICE_TIMEOUT: Duration = Duration::from_secs(3);
const ROLL_TIMEOUT: Duration = Duration::from_secs(10);

/// Why a capture stopped receiving audio. Everything captured so far is on disk.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureInterruption {
    /// The device stopped delivering audio (unplugged, stream died).
    NoAudio,
    /// Audio could not be written (disk full, permissions).
    WriteFailed,
}

impl CaptureInterruption {
    fn code(self) -> u32 {
        match self {
            Self::NoAudio => 1,
            Self::WriteFailed => 2,
        }
    }

    fn from_code(code: u32) -> Option<Self> {
        match code {
            1 => Some(Self::NoAudio),
            2 => Some(Self::WriteFailed),
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
    stop: AtomicBool,
    target: Mutex<Option<SegmentTarget>>,
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
        }
    }
}

/// Swaps the writer thread onto a new segment file between two chunks.
struct RollRequest {
    writer: SegmentWriter,
    reply: Sender<std::io::Result<u64>>,
}

struct ActiveCapture {
    note_id: String,
    shared: Arc<CaptureShared>,
    rolls: Sender<RollRequest>,
    writer_thread: JoinHandle<std::io::Result<u64>>,
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
    active: Mutex<Option<ActiveCapture>>,
}

impl Default for MeetingCapture {
    fn default() -> Self {
        Self::new()
    }
}

impl MeetingCapture {
    pub fn new() -> Self {
        Self::with_recorder(crate::platform::audio::new_streaming_recorder())
    }

    fn with_recorder(recorder: Arc<dyn Recorder>) -> Self {
        Self {
            recorder,
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

        let (sender, receiver) = mpsc::channel::<Vec<f32>>();
        let sender = Mutex::new(sender);
        let chunk_callback: ChunkCallback = Arc::new(move |samples: Vec<f32>| {
            if let Ok(sender) = sender.lock() {
                let _ = sender.send(samples);
            }
        });

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

        let shared = Arc::new(CaptureShared::default());
        shared
            .samples_written
            .store(initial_samples, Ordering::SeqCst);
        *shared.target.lock().unwrap_or_else(|p| p.into_inner()) = Some(SegmentTarget {
            segment_id,
            audio_path,
            initial_samples,
        });
        let (rolls, roll_receiver) = mpsc::channel();
        let thread_shared = Arc::clone(&shared);
        let writer_thread = std::thread::Builder::new()
            .name("meeting-capture-writer".into())
            .spawn(move || {
                run_writer(
                    writer,
                    receiver,
                    roll_receiver,
                    input_rate,
                    &thread_shared,
                    emit_progress,
                )
            })
            .map_err(|err| {
                let _ = self.recorder.stop();
                err.to_string()
            })?;

        log::info!("Meeting capture started (input rate {input_rate} Hz)");
        let capture = ActiveCapture {
            note_id,
            shared,
            rolls,
            writer_thread,
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
        let active = self.active();
        let capture = active
            .as_ref()
            .ok_or_else(|| "No meeting is being recorded".to_string())?;

        let writer = SegmentWriter::create(&audio_path).map_err(|err| err.to_string())?;
        let (reply, finished) = mpsc::channel();
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
        capture
            .rolls
            .send(RollRequest { writer, reply })
            .map_err(|_| "The meeting capture has stopped".to_string())?;
        let samples = finished
            .recv_timeout(ROLL_TIMEOUT)
            .map_err(|_| "The meeting capture did not switch segments".to_string())?
            .map_err(|err| err.to_string())?;

        *capture
            .shared
            .target
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(SegmentTarget {
            segment_id,
            audio_path,
            initial_samples: 0,
        });
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

        capture.shared.stop.store(true, Ordering::SeqCst);
        if let Err(err) = self.recorder.stop() {
            log::warn!("Meeting recorder stop reported: {err}");
        }

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

        log::info!("Meeting capture stopped ({} ms)", samples_to_ms(samples));
        let status = capture.shared.status(&capture.note_id);
        Ok(Some(MeetingCaptureStopped {
            note_id: capture.note_id,
            segment_id: status.segment_id,
            audio_path: status.audio_path,
            duration_ms: samples_to_ms(samples),
        }))
    }
}

fn run_writer(
    mut writer: SegmentWriter,
    receiver: Receiver<Vec<f32>>,
    rolls: Receiver<RollRequest>,
    input_rate: u32,
    shared: &CaptureShared,
    emit_progress: impl Fn(&CaptureShared),
) -> std::io::Result<u64> {
    let mut downsampler = Downsampler::new(input_rate);
    let mut converted = Vec::new();
    let mut last_audio = Instant::now();
    let mut last_commit = Instant::now();
    let mut last_progress = Instant::now();

    let mut write = |samples: &[f32], writer: &mut SegmentWriter| -> std::io::Result<()> {
        shared
            .level_bits
            .store(rms_level(samples).to_bits(), Ordering::Relaxed);
        converted.clear();
        downsampler.process(samples, &mut converted);
        writer.append(&converted)?;
        shared
            .samples_written
            .store(writer.samples_written(), Ordering::Relaxed);
        Ok(())
    };

    let result = loop {
        while let Ok(RollRequest {
            writer: next,
            reply,
        }) = rolls.try_recv()
        {
            let finished = std::mem::replace(&mut writer, next).finish();
            shared.samples_written.store(0, Ordering::SeqCst);
            let _ = reply.send(finished);
        }

        match receiver.recv_timeout(RECEIVE_TIMEOUT) {
            Ok(samples) => {
                if let Err(err) = write(&samples, &mut writer) {
                    break Err(err);
                }
                last_audio = Instant::now();
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                if !shared.stop.load(Ordering::SeqCst) {
                    shared.interrupt(CaptureInterruption::NoAudio);
                    emit_progress(shared);
                }
                break Ok(());
            }
        }

        if shared.stop.load(Ordering::SeqCst) {
            let drained: Result<(), std::io::Error> = receiver
                .try_iter()
                .try_for_each(|samples| write(&samples, &mut writer));
            break drained;
        }

        if last_audio.elapsed() >= SILENT_DEVICE_TIMEOUT {
            shared.interrupt(CaptureInterruption::NoAudio);
        }

        if last_commit.elapsed() >= COMMIT_INTERVAL {
            if let Err(err) = writer.commit() {
                break Err(err);
            }
            last_commit = Instant::now();
        }

        if last_progress.elapsed() >= PROGRESS_INTERVAL {
            emit_progress(shared);
            last_progress = Instant::now();
        }
    };

    if let Err(err) = &result {
        log::error!("Meeting capture write failed: {err}");
        shared.interrupt(CaptureInterruption::WriteFailed);
        emit_progress(shared);
    }

    writer.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{RecordedAudio, RecordingMetrics, RecordingResult};
    use crate::platform::LevelCallback;

    fn temp_path(name: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "voquill-meeting-capture-{}-{name}.wav",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        path
    }

    fn no_rolls() -> Receiver<RollRequest> {
        mpsc::channel().1
    }

    #[test]
    fn writer_marks_a_vanished_source_as_interrupted_and_keeps_audio() {
        let path = temp_path("vanished");
        let writer = SegmentWriter::create(&path).unwrap();
        let (sender, receiver) = mpsc::channel();
        sender.send(vec![0.25f32; 48_000]).unwrap();
        drop(sender);

        let shared = CaptureShared::default();
        let samples = run_writer(writer, receiver, no_rolls(), 48_000, &shared, |_| {}).unwrap();

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
            sender.send(vec![0.1f32; 16_000]).unwrap();
        }

        let samples = run_writer(writer, receiver, no_rolls(), 16_000, &shared, |_| {}).unwrap();

        assert_eq!(samples, 48_000);
        assert_eq!(shared.interruption(), None);
        drop(sender);
        std::fs::remove_file(path).unwrap();
    }

    /// A recorder that delivers `chunks` of 16 kHz audio from a thread, the
    /// way the platform recorders call the chunk callback.
    struct FakeRecorder {
        chunks: usize,
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
            let stop = Arc::clone(&self.stop);
            stop.store(false, Ordering::SeqCst);
            *self.thread.lock().unwrap() = Some(std::thread::spawn(move || {
                for _ in 0..chunks {
                    if stop.load(Ordering::SeqCst) {
                        return;
                    }
                    chunk(vec![0.2f32; 1_600]);
                    std::thread::sleep(Duration::from_millis(2));
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

    fn fake_capture(chunks: usize) -> MeetingCapture {
        MeetingCapture::with_recorder(Arc::new(FakeRecorder {
            chunks,
            thread: Mutex::new(None),
            stop: Arc::new(AtomicBool::new(false)),
        }))
    }

    fn wait_for(condition: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !condition() {
            assert!(Instant::now() < deadline, "timed out");
            std::thread::sleep(Duration::from_millis(5));
        }
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
        let stopped = loop {
            if capture.status().unwrap().duration_ms + rolled.finished.duration_ms >= 10_000 {
                break capture.stop().unwrap().unwrap();
            }
            std::thread::sleep(Duration::from_millis(5));
        };

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
}
