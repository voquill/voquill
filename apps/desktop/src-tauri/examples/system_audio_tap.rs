//! Records the computer's audio through the meeting system-audio source, the
//! way a meeting does, and checks what is in it: a tone another process plays
//! (`afplay`, 880 Hz) must be there, a tone this process plays (660 Hz) must
//! not, since Voquill leaves its own sounds out.
//!
//! From `apps/desktop/src-tauri`, with the volume up and nothing else playing:
//!
//!     cargo run --example system_audio_tap
//!
//! The recording is left at `$TMPDIR/voquill-system-audio-tap.wav`. The first
//! run asks for the "System Audio Recording" permission (for the terminal app
//! running it); exit code 2 means system audio was not recorded and says why.

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use desktop_lib::platform::system_audio::{new_system_audio_source, SystemAudioState};
use desktop_lib::system::meeting_audio::{
    to_pcm16, Downsampler, SegmentWriter, MEETING_SAMPLE_RATE,
};
use rodio::Source;

#[cfg(target_os = "macos")]
tauri::embed_plist::embed_info_plist!("../Info.plist");

const OTHER_PROCESS_HZ: f64 = 880.0;
const OWN_PROCESS_HZ: f64 = 660.0;
const TONE_SECONDS: f64 = 4.0;
const PERMISSION_TIMEOUT: Duration = Duration::from_secs(60);

fn write_tone(path: &PathBuf) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 48_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).expect("tone file");
    for i in 0..(48_000.0 * TONE_SECONDS) as usize {
        let value =
            0.3 * (2.0 * std::f64::consts::PI * OTHER_PROCESS_HZ * i as f64 / 48_000.0).sin();
        writer
            .write_sample((value * i16::MAX as f64) as i16)
            .expect("tone sample");
    }
    writer.finalize().expect("tone file");
}

/// Amplitude of `hz` in 16 kHz `samples`, by correlation.
fn tone_amplitude(samples: &[f32], hz: f64) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let (mut sin, mut cos) = (0.0, 0.0);
    for (i, value) in samples.iter().enumerate() {
        let phase = 2.0 * std::f64::consts::PI * hz * i as f64 / MEETING_SAMPLE_RATE as f64;
        sin += f64::from(*value) * phase.sin();
        cos += f64::from(*value) * phase.cos();
    }
    2.0 * (sin * sin + cos * cos).sqrt() / samples.len() as f64
}

#[derive(Default)]
struct Captured {
    samples: Vec<f32>,
    rates: Vec<u32>,
    chunks: usize,
    first_at: Option<Instant>,
    last_at: Option<Instant>,
}

fn main() {
    let started = Instant::now();
    let elapsed = move || format!("{:>6.2}s", started.elapsed().as_secs_f64());
    let tone_path = std::env::temp_dir().join("voquill-system-audio-tone.wav");
    let output_path = std::env::temp_dir().join("voquill-system-audio-tap.wav");
    let _ = std::fs::remove_file(&output_path);
    write_tone(&tone_path);

    // A tone from this process, which the tap must leave out. Playing it
    // first also makes this process a Core Audio client, as Voquill is.
    let (_stream, handle) = rodio::OutputStream::try_default().expect("default output");
    let own_tone = rodio::Sink::try_new(&handle).expect("sink");
    own_tone.append(rodio::source::SineWave::new(OWN_PROCESS_HZ as f32).amplify(0.3));
    own_tone.play();

    let captured = Arc::new(Mutex::new(Captured::default()));
    let states = Arc::new(Mutex::new(Vec::<SystemAudioState>::new()));
    let source = new_system_audio_source();
    let chunk_sink = Arc::clone(&captured);
    let state_sink = Arc::clone(&states);
    let state_clock = elapsed.clone();
    source.start(
        Arc::new(move |chunk| {
            let mut captured = chunk_sink.lock().unwrap();
            let now = Instant::now();
            captured.first_at.get_or_insert(now);
            captured.last_at = Some(now);
            captured.chunks += 1;
            if captured.rates.last() != Some(&chunk.sample_rate) {
                captured.rates.push(chunk.sample_rate);
            }
            captured.samples.extend_from_slice(&chunk.samples);
        }),
        Arc::new(move |state| {
            println!("{} system audio state: {state:?}", state_clock());
            state_sink.lock().unwrap().push(state);
        }),
    );

    let deadline = Instant::now() + PERMISSION_TIMEOUT;
    let final_state = loop {
        let latest = states.lock().unwrap().last().copied();
        match latest {
            Some(SystemAudioState::Recording) => break SystemAudioState::Recording,
            Some(
                state @ (SystemAudioState::Unsupported
                | SystemAudioState::Denied
                | SystemAudioState::Failed),
            ) => break state,
            _ if Instant::now() >= deadline => break SystemAudioState::Pending,
            _ => std::thread::sleep(Duration::from_millis(50)),
        }
    };
    if final_state != SystemAudioState::Recording {
        source.stop();
        println!("{} not recording system audio: {final_state:?}", elapsed());
        std::process::exit(2);
    }

    std::thread::sleep(Duration::from_millis(500));
    println!("{} playing {OTHER_PROCESS_HZ} Hz through afplay", elapsed());
    let played = Command::new("afplay").arg(&tone_path).status();
    println!("{} afplay finished: {played:?}", elapsed());
    std::thread::sleep(Duration::from_millis(500));
    let stop_started = Instant::now();
    source.stop();
    println!(
        "{} stop returned in {:?}",
        elapsed(),
        stop_started.elapsed()
    );
    own_tone.stop();
    std::thread::sleep(Duration::from_millis(300));

    let captured = captured.lock().unwrap();
    let rate = captured.rates.last().copied().unwrap_or(48_000);
    let span = match (captured.first_at, captured.last_at) {
        (Some(first), Some(last)) => last.duration_since(first).as_secs_f64(),
        _ => 0.0,
    };
    println!(
        "{} {} chunks, {} samples, reported rates {:?}, delivered at {:.0} samples/s",
        elapsed(),
        captured.chunks,
        captured.samples.len(),
        captured.rates,
        captured.samples.len() as f64 / span.max(1e-3)
    );

    let mut resampler = Downsampler::new(rate);
    let mut resampled = Vec::new();
    resampler.process(&captured.samples, &mut resampled);
    resampler.flush(&mut resampled);
    let mut writer = SegmentWriter::create(&output_path).expect("output file");
    writer
        .append(
            &resampled
                .iter()
                .map(|value| to_pcm16(*value))
                .collect::<Vec<_>>(),
        )
        .expect("output samples");
    writer.finish().expect("output file");

    let peak = resampled
        .iter()
        .fold(0.0f32, |peak, value| peak.max(value.abs()));
    let other = tone_amplitude(&resampled, OTHER_PROCESS_HZ);
    let own = tone_amplitude(&resampled, OWN_PROCESS_HZ);
    println!(
        "{} wrote {} ({:.2} s); peak {peak:.3}; {OTHER_PROCESS_HZ} Hz (afplay) amplitude {other:.4}; {OWN_PROCESS_HZ} Hz (this process) amplitude {own:.4}",
        elapsed(),
        output_path.display(),
        resampled.len() as f64 / MEETING_SAMPLE_RATE as f64
    );
    if other < 0.01 {
        println!("FAIL: the tone from another process is not in the recording (silence means the permission was refused or the volume is off)");
        std::process::exit(1);
    }
    if own > other / 10.0 {
        println!("FAIL: this process's own tone is in the recording");
        std::process::exit(1);
    }
    println!("PASS");
}
