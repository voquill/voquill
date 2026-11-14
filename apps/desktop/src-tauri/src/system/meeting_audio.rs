//! Meeting audio segments on disk: 16 kHz mono 16-bit PCM WAV, written
//! incrementally so a crash at any moment leaves every committed sample
//! readable. The header's size fields may be stale after a crash; readers use
//! the file length and `repair_segment` rewrites the header from it.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tauri::Manager;

pub const MEETING_SAMPLE_RATE: u32 = 16_000;

const MEETING_AUDIO_DIR_NAME: &str = "meeting-audio";
const HEADER_LEN: u64 = 44;
const BYTES_PER_SAMPLE: u64 = 2;
const MAX_DATA_BYTES: u64 = u32::MAX as u64 - HEADER_LEN;
const SYNC_INTERVAL: Duration = Duration::from_secs(10);

fn sanitize_id(id: &str) -> io::Result<String> {
    let sanitized: String = id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect();
    if sanitized.is_empty() || sanitized != id {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid meeting audio id",
        ));
    }
    Ok(sanitized)
}

pub fn meeting_audio_dir(app: &tauri::AppHandle) -> io::Result<PathBuf> {
    let mut path = app
        .path()
        .app_data_dir()
        .map_err(|err| io::Error::other(err.to_string()))?;
    path.push(MEETING_AUDIO_DIR_NAME);
    fs::create_dir_all(&path)?;
    Ok(path)
}

pub fn note_audio_dir(app: &tauri::AppHandle, note_id: &str) -> io::Result<PathBuf> {
    let mut path = meeting_audio_dir(app)?;
    path.push(sanitize_id(note_id)?);
    Ok(path)
}

pub fn segment_path(
    app: &tauri::AppHandle,
    note_id: &str,
    segment_id: &str,
) -> io::Result<PathBuf> {
    let mut path = note_audio_dir(app, note_id)?;
    fs::create_dir_all(&path)?;
    path.push(format!("{}.wav", sanitize_id(segment_id)?));
    Ok(path)
}

/// Rejects paths outside the managed meeting audio directory.
pub fn managed_segment_path(app: &tauri::AppHandle, path: &str) -> io::Result<PathBuf> {
    let root = meeting_audio_dir(app)?;
    let candidate = PathBuf::from(path);
    let is_managed = candidate.starts_with(&root)
        && candidate
            .components()
            .all(|part| !matches!(part, std::path::Component::ParentDir));
    if !is_managed {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Meeting audio path is outside the managed directory",
        ));
    }
    Ok(candidate)
}

pub fn delete_note_audio(app: &tauri::AppHandle, note_id: &str) -> io::Result<()> {
    let dir = note_audio_dir(app, note_id)?;
    match fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

/// A segment file on disk, identified by its directory and file names.
pub struct SegmentFile {
    pub note_id: String,
    pub segment_id: String,
    pub path: PathBuf,
}

/// Every `<noteId>/<segmentId>.wav` under the meeting audio directory.
pub fn list_segment_files(app: &tauri::AppHandle) -> io::Result<Vec<SegmentFile>> {
    let mut files = Vec::new();
    for note_dir in fs::read_dir(meeting_audio_dir(app)?)? {
        let note_dir = note_dir?;
        if !note_dir.file_type()?.is_dir() {
            continue;
        }
        let note_id = note_dir.file_name().to_string_lossy().to_string();
        for entry in fs::read_dir(note_dir.path())? {
            let path = entry?.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("wav") {
                continue;
            }
            if let Some(segment_id) = path.file_stem().and_then(|stem| stem.to_str()) {
                files.push(SegmentFile {
                    note_id: note_id.clone(),
                    segment_id: segment_id.to_string(),
                    path: path.clone(),
                });
            }
        }
    }
    Ok(files)
}

pub fn delete_all_meeting_audio(app: &tauri::AppHandle) -> io::Result<()> {
    let dir = meeting_audio_dir(app)?;
    fs::remove_dir_all(&dir)
}

pub fn delete_segment(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

pub fn samples_to_ms(samples: u64) -> u64 {
    samples * 1_000 / MEETING_SAMPLE_RATE as u64
}

fn ms_to_samples(ms: u64) -> u64 {
    ms * MEETING_SAMPLE_RATE as u64 / 1_000
}

fn wav_header(data_bytes: u32) -> [u8; HEADER_LEN as usize] {
    let mut header = [0u8; HEADER_LEN as usize];
    let byte_rate = MEETING_SAMPLE_RATE * BYTES_PER_SAMPLE as u32;
    header[0..4].copy_from_slice(b"RIFF");
    header[4..8].copy_from_slice(&(data_bytes.saturating_add(36)).to_le_bytes());
    header[8..12].copy_from_slice(b"WAVE");
    header[12..16].copy_from_slice(b"fmt ");
    header[16..20].copy_from_slice(&16u32.to_le_bytes());
    header[20..22].copy_from_slice(&1u16.to_le_bytes());
    header[22..24].copy_from_slice(&1u16.to_le_bytes());
    header[24..28].copy_from_slice(&MEETING_SAMPLE_RATE.to_le_bytes());
    header[28..32].copy_from_slice(&byte_rate.to_le_bytes());
    header[32..34].copy_from_slice(&(BYTES_PER_SAMPLE as u16).to_le_bytes());
    header[34..36].copy_from_slice(&16u16.to_le_bytes());
    header[36..40].copy_from_slice(b"data");
    header[40..44].copy_from_slice(&data_bytes.to_le_bytes());
    header
}

fn write_header_sizes(file: &mut File, data_bytes: u64) -> io::Result<()> {
    let data_bytes = data_bytes.min(MAX_DATA_BYTES) as u32;
    file.seek(SeekFrom::Start(0))?;
    file.write_all(&wav_header(data_bytes))?;
    file.seek(SeekFrom::End(0))?;
    Ok(())
}

fn verify_header(file: &mut File) -> io::Result<()> {
    let mut header = [0u8; HEADER_LEN as usize];
    file.seek(SeekFrom::Start(0))?;
    file.read_exact(&mut header)?;
    let expected = wav_header(0);
    let format_matches = header[0..4] == expected[0..4] && header[8..40] == expected[8..40];
    if !format_matches {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Not a meeting audio segment",
        ));
    }
    Ok(())
}

fn data_bytes_for_len(len: u64) -> u64 {
    let data = len.saturating_sub(HEADER_LEN).min(MAX_DATA_BYTES);
    data - data % BYTES_PER_SAMPLE
}

/// Appends go straight to the OS, so a process crash loses nothing that was
/// appended; the header is brought up to date by `commit`.
pub struct SegmentWriter {
    file: File,
    samples_written: u64,
    last_sync: Instant,
}

impl SegmentWriter {
    /// Never overwrites an existing file, so a reused segment id cannot
    /// destroy captured audio.
    pub fn create(path: &Path) -> io::Result<Self> {
        let mut file = OpenOptions::new()
            .write(true)
            .read(true)
            .create_new(true)
            .open(path)?;
        file.write_all(&wav_header(0))?;
        file.sync_all()?;
        Ok(Self {
            file,
            samples_written: 0,
            last_sync: Instant::now(),
        })
    }

    /// Continues an existing segment file after the audio it already holds
    /// (repairing it first if it was interrupted).
    pub fn open_append(path: &Path) -> io::Result<Self> {
        let samples_written = repair_segment(path)?;
        let mut file = OpenOptions::new().read(true).write(true).open(path)?;
        file.seek(SeekFrom::End(0))?;
        Ok(Self {
            file,
            samples_written,
            last_sync: Instant::now(),
        })
    }

    pub fn samples_written(&self) -> u64 {
        self.samples_written
    }

    pub fn append(&mut self, samples: &[i16]) -> io::Result<()> {
        let room = MAX_DATA_BYTES / BYTES_PER_SAMPLE - self.samples_written;
        let writable = &samples[..samples.len().min(room as usize)];
        let bytes: Vec<u8> = writable
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect();
        self.file.write_all(&bytes)?;
        self.samples_written += writable.len() as u64;
        Ok(())
    }

    /// Makes the header match the appended samples and periodically forces
    /// them to disk.
    pub fn commit(&mut self) -> io::Result<()> {
        let data_bytes = self.samples_written * BYTES_PER_SAMPLE;
        write_header_sizes(&mut self.file, data_bytes)?;
        if self.last_sync.elapsed() >= SYNC_INTERVAL {
            self.file.sync_data()?;
            self.last_sync = Instant::now();
        }
        Ok(())
    }

    pub fn finish(mut self) -> io::Result<u64> {
        self.commit()?;
        self.file.sync_all()?;
        Ok(self.samples_written)
    }
}

/// Makes an interrupted segment a valid WAV again (header sizes from the file
/// length, a torn trailing byte dropped) and returns its sample count.
pub fn repair_segment(path: &Path) -> io::Result<u64> {
    let mut file = OpenOptions::new().read(true).write(true).open(path)?;
    let len = file.metadata()?.len();

    if len < HEADER_LEN {
        file.set_len(0)?;
        file.write_all(&wav_header(0))?;
        file.sync_all()?;
        return Ok(0);
    }

    verify_header(&mut file)?;
    let data_bytes = data_bytes_for_len(len);
    if HEADER_LEN + data_bytes != len {
        file.set_len(HEADER_LEN + data_bytes)?;
    }

    let mut sizes = [0u8; 4];
    file.seek(SeekFrom::Start(40))?;
    file.read_exact(&mut sizes)?;
    if u32::from_le_bytes(sizes) as u64 != data_bytes {
        write_header_sizes(&mut file, data_bytes)?;
        file.sync_all()?;
    }

    Ok(data_bytes / BYTES_PER_SAMPLE)
}

/// Raw little-endian i16 PCM for `[start_ms, end_ms)`, clamped to the audio
/// actually on disk.
pub fn read_segment_pcm(path: &Path, start_ms: u64, end_ms: u64) -> io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    verify_header(&mut file)?;
    let total_samples = data_bytes_for_len(file.metadata()?.len()) / BYTES_PER_SAMPLE;
    let start = ms_to_samples(start_ms).min(total_samples);
    let end = ms_to_samples(end_ms).clamp(start, total_samples);

    let mut bytes = vec![0u8; ((end - start) * BYTES_PER_SAMPLE) as usize];
    file.seek(SeekFrom::Start(HEADER_LEN + start * BYTES_PER_SAMPLE))?;
    file.read_exact(&mut bytes)?;
    Ok(bytes)
}

/// RMS loudness (0..1) for each consecutive `window_ms` of the segment.
pub fn segment_envelope(path: &Path, window_ms: u64) -> io::Result<Vec<f32>> {
    let window_samples = ms_to_samples(window_ms.max(1)).max(1) as usize;
    let mut file = File::open(path)?;
    verify_header(&mut file)?;
    let total_bytes = data_bytes_for_len(file.metadata()?.len());
    file.seek(SeekFrom::Start(HEADER_LEN))?;
    let mut reader = io::BufReader::new(file.take(total_bytes));

    let mut envelope = Vec::new();
    let mut window = vec![0u8; window_samples * BYTES_PER_SAMPLE as usize];
    loop {
        let mut filled = 0;
        while filled < window.len() {
            let read = reader.read(&mut window[filled..])?;
            if read == 0 {
                break;
            }
            filled += read;
        }
        let samples = filled / BYTES_PER_SAMPLE as usize;
        if samples == 0 {
            break;
        }
        let sum_squares: f64 = window[..samples * 2]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| {
                let value = i16::from_le_bytes(*pair) as f64 / i16::MAX as f64;
                value * value
            })
            .sum();
        envelope.push((sum_squares / samples as f64).sqrt() as f32);
        if filled < window.len() {
            break;
        }
    }
    Ok(envelope)
}

/// Converts mono f32 audio at the device rate to 16 kHz f32 with a
/// windowed-sinc (Hann) low-pass at 0.45 × the lower of the two rates, so
/// speech keeps its full band and content above 8 kHz does not alias.
///
/// The filter is precomputed as a polyphase table when the converter is
/// built: one kernel per fractional output position (one for 48 kHz, 160 for
/// 44.1 kHz). Rates with more distinct positions than `MAX_RESAMPLER_PHASES`
/// use the nearest of that many. Processing then only multiplies and adds,
/// and never allocates: input history lives in a fixed ring. Each output
/// waits for `half_width` input samples of lookahead; `flush` emits the rest
/// at the end of a capture. 16 kHz input passes straight through. Output is
/// not clamped: mixing happens before `to_pcm16` quantizes it.
pub struct Downsampler {
    input_rate: u64,
    passthrough: bool,
    half_width: usize,
    taps: usize,
    phases: u64,
    /// `phases × taps` normalized weights; phase `p` is at offset `p × taps`.
    kernels: Vec<f32>,
    /// The last `ring.len()` input samples; sample `i` lives at `i % len`.
    ring: Vec<f32>,
    first_sample: f32,
    consumed: u64,
    produced: u64,
}

/// Kernel width in cycles of the cutoff: wide enough for a steep transition.
const RESAMPLER_ZERO_CROSSINGS: f64 = 16.0;
/// Bounds the table for unusual rates (at most 1/1024 of a sample off).
const MAX_RESAMPLER_PHASES: u64 = 1_024;

fn greatest_common_divisor(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

pub fn to_pcm16(value: f32) -> i16 {
    let value = if value.is_finite() { value } else { 0.0 };
    (value.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16
}

fn finite_or_zero(sample: f32) -> f32 {
    if sample.is_finite() {
        sample
    } else {
        0.0
    }
}

impl Downsampler {
    pub fn new(input_rate: u32) -> Self {
        let input_rate = u64::from(input_rate.max(1));
        let output_rate = u64::from(MEETING_SAMPLE_RATE);
        let step = input_rate as f64 / output_rate as f64;
        let cutoff = 0.45 * (1.0 / step).min(1.0);
        let half_width = (RESAMPLER_ZERO_CROSSINGS / (2.0 * cutoff)).ceil() as usize;
        let taps = 2 * half_width + 1;
        let phases = (output_rate / greatest_common_divisor(input_rate, output_rate))
            .min(MAX_RESAMPLER_PHASES);
        let passthrough = input_rate == output_rate;

        let mut kernels = Vec::new();
        if !passthrough {
            kernels.reserve_exact(phases as usize * taps);
            for phase in 0..phases {
                let fraction = phase as f64 / phases as f64;
                let start = kernels.len();
                for tap in 0..taps {
                    let distance = fraction - (tap as f64 - half_width as f64);
                    let x = 2.0 * cutoff * distance;
                    let sinc = if x.abs() < 1e-9 {
                        1.0
                    } else {
                        (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x)
                    };
                    let window = if distance.abs() <= half_width as f64 + 1.0 {
                        0.5 + 0.5
                            * (std::f64::consts::PI * distance / (half_width as f64 + 1.0)).cos()
                    } else {
                        0.0
                    };
                    kernels.push((sinc * window) as f32);
                }
                let sum: f32 = kernels[start..].iter().sum();
                if sum.abs() > 1e-12 {
                    kernels[start..]
                        .iter_mut()
                        .for_each(|weight| *weight /= sum);
                }
            }
        }

        Self {
            input_rate,
            passthrough,
            half_width,
            taps,
            phases,
            kernels,
            // Room for one kernel's span plus the input of one output step.
            ring: vec![0.0; (taps + step.ceil() as usize + 2).next_power_of_two()],
            first_sample: 0.0,
            consumed: 0,
            produced: 0,
        }
    }

    /// Input sample `index`, holding the first one before the start and the
    /// last one past the end (for `flush`).
    fn sample_at(&self, index: i64) -> f32 {
        if index < 0 {
            return self.first_sample;
        }
        let index = (index as u64).min(self.consumed.saturating_sub(1));
        self.ring[(index % self.ring.len() as u64) as usize]
    }

    /// Where output `produced` sits: the input sample at or before it, and
    /// which precomputed phase covers the fraction.
    fn position(&self) -> (i64, usize) {
        let output_rate = u64::from(MEETING_SAMPLE_RATE);
        let numerator = self.produced * self.input_rate;
        let mut whole = numerator / output_rate;
        let remainder = numerator % output_rate;
        let mut phase = (remainder * self.phases + output_rate / 2) / output_rate;
        if phase == self.phases {
            whole += 1;
            phase = 0;
        }
        (whole as i64, phase as usize)
    }

    fn emit(&mut self, output: &mut Vec<f32>) {
        let (whole, phase) = self.position();
        let kernel = &self.kernels[phase * self.taps..(phase + 1) * self.taps];
        let first = whole - self.half_width as i64;
        let mut sum = 0.0f32;
        for (tap, weight) in kernel.iter().enumerate() {
            sum += weight * self.sample_at(first + tap as i64);
        }
        output.push(sum);
        self.produced += 1;
    }

    /// The output position is at or before the last input sample.
    fn has_input_for_next(&self) -> bool {
        (self.produced * self.input_rate) < self.consumed * u64::from(MEETING_SAMPLE_RATE)
    }

    pub fn process(&mut self, input: &[f32], output: &mut Vec<f32>) {
        if self.passthrough {
            output.extend(input.iter().copied().map(finite_or_zero));
            return;
        }
        let ring_len = self.ring.len() as u64;
        for &sample in input {
            let sample = finite_or_zero(sample);
            if self.consumed == 0 {
                self.first_sample = sample;
            }
            self.ring[(self.consumed % ring_len) as usize] = sample;
            self.consumed += 1;
            while self.has_input_for_next() {
                let (whole, _) = self.position();
                if whole + self.half_width as i64 >= self.consumed as i64 {
                    break;
                }
                self.emit(output);
            }
        }
    }

    /// The outputs still waiting for lookahead, at the end of the input.
    pub fn flush(&mut self, output: &mut Vec<f32>) {
        if self.passthrough {
            return;
        }
        while self.has_input_for_next() {
            self.emit(output);
        }
    }
}

pub fn rms_level(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f32 = samples.iter().map(|value| value * value).sum();
    (sum / samples.len() as f32).sqrt().clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "voquill-meeting-audio-{}-{}-{name}.wav",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        path
    }

    fn read_with_hound(path: &Path) -> Vec<i16> {
        let mut reader = hound::WavReader::open(path).unwrap();
        assert_eq!(reader.spec().sample_rate, MEETING_SAMPLE_RATE);
        assert_eq!(reader.spec().channels, 1);
        reader.samples::<i16>().map(|s| s.unwrap()).collect()
    }

    #[test]
    fn finished_segment_is_a_valid_wav() {
        let path = temp_path("finished");
        let mut writer = SegmentWriter::create(&path).unwrap();
        writer.append(&[1, -2, 3]).unwrap();
        writer.commit().unwrap();
        writer.append(&[4]).unwrap();
        assert_eq!(writer.finish().unwrap(), 4);
        assert_eq!(read_with_hound(&path), vec![1, -2, 3, 4]);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn append_continues_after_the_existing_samples() {
        let path = temp_path("append");
        let mut writer = SegmentWriter::create(&path).unwrap();
        writer.append(&[1, 2]).unwrap();
        drop(writer);

        let mut appending = SegmentWriter::open_append(&path).unwrap();
        assert_eq!(appending.samples_written(), 2);
        appending.append(&[3]).unwrap();
        assert_eq!(appending.finish().unwrap(), 3);
        assert_eq!(read_with_hound(&path), vec![1, 2, 3]);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn create_refuses_to_overwrite() {
        let path = temp_path("exists");
        SegmentWriter::create(&path).unwrap().finish().unwrap();
        assert!(SegmentWriter::create(&path).is_err());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn interrupted_segment_keeps_every_appended_sample_after_repair() {
        let path = temp_path("interrupted");
        let mut writer = SegmentWriter::create(&path).unwrap();
        writer.append(&[10, 20]).unwrap();
        writer.commit().unwrap();
        writer.append(&[30, 40, 50]).unwrap();
        drop(writer);

        // Header still claims 2 samples; a torn half sample is appended.
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(&[7])
            .unwrap();

        assert_eq!(repair_segment(&path).unwrap(), 5);
        assert_eq!(read_with_hound(&path), vec![10, 20, 30, 40, 50]);
        assert_eq!(repair_segment(&path).unwrap(), 5);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn repair_handles_a_file_torn_inside_the_header() {
        let path = temp_path("torn-header");
        fs::write(&path, b"RIFF").unwrap();
        assert_eq!(repair_segment(&path).unwrap(), 0);
        assert!(read_with_hound(&path).is_empty());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn repair_rejects_foreign_files() {
        let path = temp_path("foreign");
        fs::write(&path, vec![0u8; 100]).unwrap();
        assert!(repair_segment(&path).is_err());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn read_pcm_ignores_a_stale_header_and_clamps_ranges() {
        let path = temp_path("read");
        let mut writer = SegmentWriter::create(&path).unwrap();
        let samples: Vec<i16> = (0..32_000).map(|value| value as i16).collect();
        writer.append(&samples).unwrap();
        drop(writer);

        let bytes = read_segment_pcm(&path, 1_000, 5_000).unwrap();
        assert_eq!(bytes.len(), 16_000 * 2);
        assert_eq!(i16::from_le_bytes([bytes[0], bytes[1]]), 16_000);
        assert!(read_segment_pcm(&path, 3_000, 4_000).unwrap().is_empty());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn envelope_reports_loudness_per_window() {
        let path = temp_path("envelope");
        let mut writer = SegmentWriter::create(&path).unwrap();
        writer.append(&vec![0i16; 1_600]).unwrap();
        writer.append(&vec![i16::MAX; 1_600]).unwrap();
        writer.append(&vec![i16::MAX; 800]).unwrap();
        writer.finish().unwrap();

        let envelope = segment_envelope(&path, 100).unwrap();
        assert_eq!(envelope.len(), 3);
        assert_eq!(envelope[0], 0.0);
        assert!((envelope[1] - 1.0).abs() < 1e-6);
        assert!((envelope[2] - 1.0).abs() < 1e-6);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn downsampler_produces_16k_from_common_rates() {
        for rate in [
            48_000u32, 44_100, 96_000, 32_000, 22_050, 16_000, 8_000, 47_999,
        ] {
            let mut downsampler = Downsampler::new(rate);
            let mut output = Vec::new();
            let input = vec![0.5f32; rate as usize / 10];
            for chunk in input.chunks(441) {
                downsampler.process(chunk, &mut output);
            }
            downsampler.flush(&mut output);
            assert!(
                (output.len() as i64 - 1_600).abs() <= 1,
                "rate {rate} produced {}",
                output.len()
            );
            assert!(output.iter().all(|value| (*value - 0.5).abs() < 1e-4));
        }
    }

    fn sine(rate: u32, hz: f64, seconds: f64) -> Vec<f32> {
        (0..(rate as f64 * seconds) as usize)
            .map(|i| {
                (0.8 * (2.0 * std::f64::consts::PI * hz * i as f64 / rate as f64).sin()) as f32
            })
            .collect()
    }

    fn rms_middle(samples: &[f32]) -> f64 {
        let middle = &samples[samples.len() / 4..samples.len() * 3 / 4];
        (middle.iter().map(|v| f64::from(*v).powi(2)).sum::<f64>() / middle.len() as f64).sqrt()
    }

    #[test]
    fn downsampler_keeps_speech_and_removes_what_would_alias() {
        let input_rms = 0.8 / 2f64.sqrt();
        for rate in [48_000u32, 44_100] {
            for (hz, min_gain, max_gain) in [
                (300.0, 0.97, 1.03),
                (3_000.0, 0.97, 1.03),
                (6_000.0, 0.9, 1.05),
            ] {
                let mut downsampler = Downsampler::new(rate);
                let mut output = Vec::new();
                for chunk in sine(rate, hz, 0.5).chunks(480) {
                    downsampler.process(chunk, &mut output);
                }
                let gain = rms_middle(&output) / input_rms;
                assert!(
                    gain > min_gain && gain < max_gain,
                    "{rate} Hz input, {hz} Hz: gain {gain}"
                );
            }
            for hz in [9_000.0, 12_000.0, 20_000.0] {
                let mut downsampler = Downsampler::new(rate);
                let mut output = Vec::new();
                downsampler.process(&sine(rate, hz, 0.5), &mut output);
                let gain = rms_middle(&output) / input_rms;
                assert!(
                    gain < 0.03,
                    "{rate} Hz input, {hz} Hz leaked with gain {gain}"
                );
            }
        }
    }

    #[test]
    fn downsampler_odd_rates_use_a_bounded_table_and_still_filter() {
        let rate = 47_999;
        let downsampler = Downsampler::new(rate);
        assert_eq!(downsampler.phases, MAX_RESAMPLER_PHASES);
        let input_rms = 0.8 / 2f64.sqrt();
        for (hz, expect_pass) in [(1_000.0, true), (12_000.0, false)] {
            let mut downsampler = Downsampler::new(rate);
            let mut output = Vec::new();
            downsampler.process(&sine(rate, hz, 0.5), &mut output);
            let gain = rms_middle(&output) / input_rms;
            if expect_pass {
                assert!((gain - 1.0).abs() < 0.03, "{hz} Hz gain {gain}");
            } else {
                assert!(gain < 0.03, "{hz} Hz leaked with gain {gain}");
            }
        }
    }

    #[test]
    fn downsampler_keeps_its_buffers_fixed_while_processing() {
        for rate in [48_000u32, 44_100] {
            let mut downsampler = Downsampler::new(rate);
            let ring = (downsampler.ring.len(), downsampler.ring.capacity());
            let kernels = downsampler.kernels.capacity();
            let mut output = Vec::with_capacity(4_096);
            for chunk in sine(rate, 440.0, 2.0).chunks(rate as usize / 10) {
                output.clear();
                downsampler.process(chunk, &mut output);
            }
            assert_eq!((downsampler.ring.len(), downsampler.ring.capacity()), ring);
            assert_eq!(downsampler.kernels.capacity(), kernels);
            assert_eq!(output.capacity(), 4_096, "the caller's buffer is reused");
        }
    }

    /// Cost of resampling one second of audio, as a meeting does for hours:
    /// `cargo test --release --lib resampler_cost -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn resampler_cost_per_second_of_audio() {
        const SECONDS: usize = 120;
        for rate in [48_000u32, 44_100] {
            let input = sine(rate, 440.0, 1.0);
            let chunk = rate as usize / 10;
            let mut downsampler = Downsampler::new(rate);
            let mut output = Vec::with_capacity(4_096);
            let started = std::time::Instant::now();
            for _ in 0..SECONDS {
                for piece in input.chunks(chunk) {
                    output.clear();
                    downsampler.process(piece, &mut output);
                }
            }
            let per_second = started.elapsed().as_secs_f64() * 1_000.0 / SECONDS as f64;
            println!("resampler {rate} Hz -> 16 kHz: {per_second:.3} ms per second of audio");
        }
    }

    #[test]
    fn sanitize_rejects_path_tricks() {
        assert!(sanitize_id("../etc").is_err());
        assert!(sanitize_id("").is_err());
        assert_eq!(sanitize_id("abc-123_x").unwrap(), "abc-123_x");
    }
}
