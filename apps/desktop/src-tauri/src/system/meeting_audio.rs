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
            .chunks_exact(2)
            .map(|pair| {
                let value = i16::from_le_bytes([pair[0], pair[1]]) as f64 / i16::MAX as f64;
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

/// Converts mono f32 audio at the device rate to 16 kHz i16 by averaging the
/// input samples that fall into each output sample's span (a box low-pass
/// that keeps downsampling from aliasing badly), holding the last value when
/// the device rate is below 16 kHz.
pub struct Downsampler {
    step: f64,
    consumed: u64,
    produced: u64,
    sum: f64,
    count: u32,
    last: f64,
}

impl Downsampler {
    pub fn new(input_rate: u32) -> Self {
        Self {
            step: input_rate.max(1) as f64 / MEETING_SAMPLE_RATE as f64,
            consumed: 0,
            produced: 0,
            sum: 0.0,
            count: 0,
            last: 0.0,
        }
    }

    pub fn process(&mut self, input: &[f32], output: &mut Vec<i16>) {
        for &sample in input {
            let value = if sample.is_finite() {
                sample as f64
            } else {
                0.0
            };
            self.sum += value;
            self.count += 1;
            self.consumed += 1;
            while self.consumed as f64 >= (self.produced + 1) as f64 * self.step {
                let average = if self.count > 0 {
                    self.sum / self.count as f64
                } else {
                    self.last
                };
                output.push((average.clamp(-1.0, 1.0) * i16::MAX as f64).round() as i16);
                self.last = average;
                self.sum = 0.0;
                self.count = 0;
                self.produced += 1;
            }
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
        for rate in [48_000u32, 44_100, 16_000, 8_000] {
            let mut downsampler = Downsampler::new(rate);
            let mut output = Vec::new();
            let input = vec![0.5f32; rate as usize / 10];
            for chunk in input.chunks(441) {
                downsampler.process(chunk, &mut output);
            }
            assert!(
                (output.len() as i64 - 1_600).abs() <= 1,
                "rate {rate} produced {}",
                output.len()
            );
            assert!(output.iter().all(|value| (*value - 16_384).abs() <= 1));
        }
    }

    #[test]
    fn downsampler_averages_away_content_above_nyquist() {
        let mut downsampler = Downsampler::new(48_000);
        let mut output = Vec::new();
        let alternating: Vec<f32> = (0..4_800)
            .map(|i| if i % 2 == 0 { 0.9 } else { -0.9 })
            .collect();
        downsampler.process(&alternating, &mut output);
        let peak = output.iter().map(|v| v.unsigned_abs()).max().unwrap();
        assert!(peak <= i16::MAX as u16 / 3 + 1);
    }

    #[test]
    fn sanitize_rejects_path_tricks() {
        assert!(sanitize_id("../etc").is_err());
        assert!(sanitize_id("").is_err());
        assert_eq!(sanitize_id("abc-123_x").unwrap(), "abc-123_x");
    }
}
