use rodio::source::{Source, Zero};
use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink};
use std::io::Cursor;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;

/// How long the output stream stays open after the last chime. An open stream
/// keeps CoreAudio running (and Bluetooth headphones awake) even while silent,
/// so on macOS it is released when idle. 30s covers most dictations, so the
/// stop chime usually reuses the start chime's stream. Other platforms keep the
/// stream open for the life of the app; releasing it is untested there.
#[cfg(target_os = "macos")]
const OUTPUT_IDLE_TIMEOUT: Option<Duration> = Some(Duration::from_secs(30));
#[cfg(not(target_os = "macos"))]
const OUTPUT_IDLE_TIMEOUT: Option<Duration> = None;

/// Silence played ahead of a chime on a freshly opened stream. Bluetooth
/// headphones drop the first moments of audio while waking, which would
/// otherwise swallow the short chimes entirely.
const WAKE_PREROLL: Duration = Duration::from_millis(250);

static START_RECORDING_CLIP: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/audio/start-recording.wav"
));

static STOP_RECORDING_CLIP: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/audio/stop-recording.wav"
));

static ALERT_LINUX_CLIP: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/audio/alert-linux.wav"
));

static ALERT_MACOS_CLIP: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/audio/alert-macos.wav"
));

static ALERT_WINDOWS_10_CLIP: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/audio/alert-windows-10.wav"
));

static ALERT_WINDOWS_11_CLIP: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/audio/alert-windows-11.wav"
));

/// Channel sender for the audio thread.
static AUDIO_SENDER: OnceLock<Sender<AudioRequest>> = OnceLock::new();

enum AudioRequest {
    Play(&'static [u8]),
}

/// Start the dedicated chime playback thread. See `OUTPUT_IDLE_TIMEOUT` for
/// how long its output stream stays open.
pub fn start_audio_thread() {
    let (tx, rx) = mpsc::channel::<AudioRequest>();

    if AUDIO_SENDER.set(tx).is_err() {
        log::warn!("Audio sender already initialized");
        return;
    }

    thread::spawn(move || {
        let mut output = match OUTPUT_IDLE_TIMEOUT {
            Some(_) => None,
            None => open_output(),
        };

        loop {
            let request = match OUTPUT_IDLE_TIMEOUT {
                Some(timeout) => rx.recv_timeout(timeout),
                None => rx.recv().map_err(RecvTimeoutError::from),
            };
            match request {
                Ok(AudioRequest::Play(bytes)) => {
                    let fresh = output.is_none();
                    if fresh {
                        output = open_output();
                    }
                    match &output {
                        Some((_, handle)) => play_on(handle, bytes, fresh),
                        None => play_clip_fallback(bytes),
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    if output.take().is_some() {
                        log::debug!("Released idle audio output stream");
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    });
}

fn open_output() -> Option<(OutputStream, OutputStreamHandle)> {
    OutputStream::try_default()
        .inspect_err(|err| log::error!("Failed to open default audio output stream: {err}"))
        .ok()
}

/// `fresh` means the stream was just opened, so the device may still be waking.
fn play_on(handle: &OutputStreamHandle, bytes: &'static [u8], fresh: bool) {
    let sink = match Sink::try_new(handle) {
        Ok(sink) => sink,
        Err(err) => {
            log::error!("Failed to create audio sink: {err}");
            return;
        }
    };
    let source = match Decoder::new(Cursor::new(bytes)) {
        Ok(source) => source,
        Err(err) => {
            log::error!("Failed to decode audio clip: {err}");
            return;
        }
    };
    if fresh {
        let silence = Zero::<f32>::new(source.channels(), source.sample_rate());
        sink.append(silence.take_duration(WAKE_PREROLL));
    }
    sink.append(source);
    sink.sleep_until_end();
}

fn try_send_to_audio_thread(bytes: &'static [u8]) -> bool {
    if let Some(sender) = AUDIO_SENDER.get() {
        sender.send(AudioRequest::Play(bytes)).is_ok()
    } else {
        false
    }
}

pub fn play_start_recording_clip() {
    play_clip(START_RECORDING_CLIP);
}

pub fn play_stop_recording_clip() {
    play_clip(STOP_RECORDING_CLIP);
}

pub fn play_alert_linux_clip() {
    play_clip(ALERT_LINUX_CLIP);
}

pub fn play_alert_macos_clip() {
    play_clip(ALERT_MACOS_CLIP);
}

pub fn play_alert_windows_10_clip() {
    play_clip(ALERT_WINDOWS_10_CLIP);
}

pub fn play_alert_windows_11_clip() {
    play_clip(ALERT_WINDOWS_11_CLIP);
}

fn play_clip(bytes: &'static [u8]) {
    if try_send_to_audio_thread(bytes) {
        return;
    }

    // Fallback: spawn a new thread with its own stream
    play_clip_fallback(bytes);
}

fn play_clip_fallback(bytes: &'static [u8]) {
    thread::spawn(move || {
        if let Some((_stream, handle)) = open_output() {
            play_on(&handle, bytes, true);
        }
    });
}
