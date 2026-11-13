//! Meeting capture: records the microphone into a meeting audio segment on a
//! dedicated recorder instance, independent of dictation. The microphone is
//! the only source today; another source (system audio) would feed the same
//! writer thread.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
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

#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MeetingCaptureStatus {
    pub note_id: String,
    pub segment_id: String,
    pub audio_path: String,
    pub duration_ms: u64,
    pub level: f32,
    /// Audio stopped arriving (device unplugged, stream died, disk error).
    /// Everything captured so far is on disk.
    pub interrupted: bool,
}

#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MeetingCaptureStopped {
    pub note_id: String,
    pub segment_id: String,
    pub audio_path: String,
    pub duration_ms: u64,
}

#[derive(Default)]
struct CaptureCounters {
    samples_written: AtomicU64,
    level_bits: AtomicU32,
    interrupted: AtomicBool,
    stop: AtomicBool,
}

struct ActiveCapture {
    note_id: String,
    segment_id: String,
    audio_path: PathBuf,
    counters: Arc<CaptureCounters>,
    writer_thread: JoinHandle<std::io::Result<u64>>,
}

impl ActiveCapture {
    fn status(&self) -> MeetingCaptureStatus {
        status_from(
            &self.note_id,
            &self.segment_id,
            &self.audio_path,
            &self.counters,
        )
    }
}

fn status_from(
    note_id: &str,
    segment_id: &str,
    audio_path: &std::path::Path,
    counters: &CaptureCounters,
) -> MeetingCaptureStatus {
    MeetingCaptureStatus {
        note_id: note_id.to_string(),
        segment_id: segment_id.to_string(),
        audio_path: audio_path.to_string_lossy().to_string(),
        duration_ms: samples_to_ms(counters.samples_written.load(Ordering::Relaxed)),
        level: f32::from_bits(counters.level_bits.load(Ordering::Relaxed)),
        interrupted: counters.interrupted.load(Ordering::Relaxed),
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
        Self {
            recorder: crate::platform::audio::new_streaming_recorder(),
            active: Mutex::new(None),
        }
    }

    fn active(&self) -> std::sync::MutexGuard<'_, Option<ActiveCapture>> {
        self.active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn status(&self) -> Option<MeetingCaptureStatus> {
        self.active().as_ref().map(ActiveCapture::status)
    }

    pub fn start(
        &self,
        app: &AppHandle,
        note_id: String,
        segment_id: String,
        audio_path: PathBuf,
        preferred_microphone: Option<String>,
    ) -> Result<MeetingCaptureStatus, String> {
        let mut active = self.active();
        if active.is_some() {
            return Err("A meeting is already being recorded".to_string());
        }

        let writer = SegmentWriter::create(&audio_path).map_err(|err| err.to_string())?;

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
            let _ = crate::system::meeting_audio::delete_segment(&audio_path);
            return Err(err.to_string());
        }
        let input_rate = self
            .recorder
            .current_sample_rate()
            .unwrap_or(MEETING_SAMPLE_RATE);

        let counters = Arc::new(CaptureCounters::default());
        let thread_counters = Arc::clone(&counters);
        let thread_app = app.clone();
        let thread_note_id = note_id.clone();
        let thread_segment_id = segment_id.clone();
        let thread_path = audio_path.clone();
        let writer_thread = std::thread::Builder::new()
            .name("meeting-capture-writer".into())
            .spawn(move || {
                run_writer(writer, receiver, input_rate, &thread_counters, |counters| {
                    let status =
                        status_from(&thread_note_id, &thread_segment_id, &thread_path, counters);
                    if let Err(err) = thread_app.emit(EVT_MEETING_CAPTURE_PROGRESS, status) {
                        log::error!("Failed to emit meeting capture progress: {err}");
                    }
                })
            })
            .map_err(|err| {
                let _ = self.recorder.stop();
                err.to_string()
            })?;

        log::info!("Meeting capture started (input rate {input_rate} Hz)");
        let capture = ActiveCapture {
            note_id,
            segment_id,
            audio_path,
            counters,
            writer_thread,
        };
        let status = capture.status();
        *active = Some(capture);
        Ok(status)
    }

    pub fn stop(&self) -> Result<Option<MeetingCaptureStopped>, String> {
        let Some(capture) = self.active().take() else {
            return Ok(None);
        };

        capture.counters.stop.store(true, Ordering::SeqCst);
        if let Err(err) = self.recorder.stop() {
            log::warn!("Meeting recorder stop reported: {err}");
        }

        let samples = match capture.writer_thread.join() {
            Ok(Ok(samples)) => samples,
            Ok(Err(err)) => {
                log::error!("Meeting segment finalize failed: {err}");
                capture.counters.samples_written.load(Ordering::SeqCst)
            }
            Err(_) => {
                log::error!("Meeting capture writer panicked");
                capture.counters.samples_written.load(Ordering::SeqCst)
            }
        };

        log::info!("Meeting capture stopped ({} ms)", samples_to_ms(samples));
        Ok(Some(MeetingCaptureStopped {
            note_id: capture.note_id,
            segment_id: capture.segment_id,
            audio_path: capture.audio_path.to_string_lossy().to_string(),
            duration_ms: samples_to_ms(samples),
        }))
    }
}

fn run_writer(
    mut writer: SegmentWriter,
    receiver: Receiver<Vec<f32>>,
    input_rate: u32,
    counters: &CaptureCounters,
    emit_progress: impl Fn(&CaptureCounters),
) -> std::io::Result<u64> {
    let mut downsampler = Downsampler::new(input_rate);
    let mut converted = Vec::new();
    let mut last_audio = Instant::now();
    let mut last_commit = Instant::now();
    let mut last_progress = Instant::now();

    let mut write = |samples: &[f32], writer: &mut SegmentWriter| -> std::io::Result<()> {
        counters
            .level_bits
            .store(rms_level(samples).to_bits(), Ordering::Relaxed);
        converted.clear();
        downsampler.process(samples, &mut converted);
        writer.append(&converted)?;
        counters
            .samples_written
            .store(writer.samples_written(), Ordering::Relaxed);
        Ok(())
    };

    let result = loop {
        match receiver.recv_timeout(RECEIVE_TIMEOUT) {
            Ok(samples) => {
                if let Err(err) = write(&samples, &mut writer) {
                    break Err(err);
                }
                last_audio = Instant::now();
                counters.interrupted.store(false, Ordering::Relaxed);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                if !counters.stop.load(Ordering::SeqCst) {
                    counters.interrupted.store(true, Ordering::Relaxed);
                    emit_progress(counters);
                }
                break Ok(());
            }
        }

        if counters.stop.load(Ordering::SeqCst) {
            let drained: Result<(), std::io::Error> = receiver
                .try_iter()
                .try_for_each(|samples| write(&samples, &mut writer));
            break drained;
        }

        if last_audio.elapsed() >= SILENT_DEVICE_TIMEOUT {
            counters.interrupted.store(true, Ordering::Relaxed);
        }

        if last_commit.elapsed() >= COMMIT_INTERVAL {
            if let Err(err) = writer.commit() {
                break Err(err);
            }
            last_commit = Instant::now();
        }

        if last_progress.elapsed() >= PROGRESS_INTERVAL {
            emit_progress(counters);
            last_progress = Instant::now();
        }
    };

    if let Err(err) = &result {
        log::error!("Meeting capture write failed: {err}");
        counters.interrupted.store(true, Ordering::Relaxed);
        emit_progress(counters);
    }

    writer.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

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
        sender.send(vec![0.25f32; 48_000]).unwrap();
        drop(sender);

        let counters = CaptureCounters::default();
        let samples = run_writer(writer, receiver, 48_000, &counters, |_| {}).unwrap();

        assert_eq!(samples, 16_000);
        assert!(counters.interrupted.load(Ordering::SeqCst));
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
        let counters = CaptureCounters::default();
        counters.stop.store(true, Ordering::SeqCst);
        for _ in 0..3 {
            sender.send(vec![0.1f32; 16_000]).unwrap();
        }

        let samples = run_writer(writer, receiver, 16_000, &counters, |_| {}).unwrap();

        assert_eq!(samples, 48_000);
        assert!(!counters.interrupted.load(Ordering::SeqCst));
        drop(sender);
        std::fs::remove_file(path).unwrap();
    }
}
