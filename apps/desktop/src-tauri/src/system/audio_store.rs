use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use tauri::Manager;

use hound::{SampleFormat, WavReader, WavSpec, WavWriter};

use crate::domain::TranscriptionAudioSnapshot;

const AUDIO_DIR_NAME: &str = "transcription-audio";

fn map_hound_error(err: hound::Error) -> io::Error {
    io::Error::other(err.to_string())
}

fn sanitize_id(id: &str) -> String {
    let mut sanitized = id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect::<String>();

    if sanitized.is_empty() {
        sanitized = "transcription".to_string();
    }

    sanitized
}

pub fn audio_dir(app: &tauri::AppHandle) -> io::Result<PathBuf> {
    let mut path = app
        .path()
        .app_data_dir()
        .map_err(|err| io::Error::other(err.to_string()))?;
    path.push(AUDIO_DIR_NAME);
    fs::create_dir_all(&path)?;
    Ok(path)
}

/// Removes every stored dictation recording (local data is being cleared).
pub fn delete_all_transcription_audio(app: &tauri::AppHandle) -> io::Result<()> {
    let dir = audio_dir(app)?;
    fs::remove_dir_all(&dir)
}

pub fn audio_path_for(app: &tauri::AppHandle, transcription_id: &str) -> io::Result<PathBuf> {
    let mut path = audio_dir(app)?;
    path.push(format!("{}.wav", sanitize_id(transcription_id)));
    Ok(path)
}

pub fn save_transcription_audio(
    app: &tauri::AppHandle,
    transcription_id: &str,
    samples: &[f32],
    sample_rate: u32,
) -> io::Result<TranscriptionAudioSnapshot> {
    if samples.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Cannot persist empty audio buffer",
        ));
    }

    if sample_rate == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Audio sample rate must be greater than zero",
        ));
    }

    let path = audio_path_for(app, transcription_id)?;

    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };

    let mut writer = WavWriter::create(&path, spec).map_err(map_hound_error)?;
    for sample in samples {
        let normalized = sample.clamp(-1.0, 1.0);
        let quantized = (normalized * i16::MAX as f32).round() as i16;
        writer.write_sample(quantized).map_err(map_hound_error)?;
    }
    writer.finalize().map_err(map_hound_error)?;

    let duration_ms = ((samples.len() as f64 / sample_rate as f64) * 1_000.0).round() as i64;

    Ok(TranscriptionAudioSnapshot {
        file_path: path.to_string_lossy().to_string(),
        duration_ms,
    })
}

pub fn delete_audio_file(app: &tauri::AppHandle, file_path: &Path) -> io::Result<()> {
    let audio_dir = audio_dir(app)?;

    if !file_path.starts_with(&audio_dir) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Refusing to delete audio outside of managed directory",
        ));
    }

    match fs::remove_file(file_path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

pub fn load_audio_samples(path: &Path) -> io::Result<(Vec<f32>, u32)> {
    let mut reader = WavReader::open(path).map_err(map_hound_error)?;
    let spec = reader.spec();

    if spec.sample_rate == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Audio file missing sample rate",
        ));
    }

    if spec.channels == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Audio file missing channel information",
        ));
    }

    let channels = spec.channels as usize;
    let capacity = reader.duration() as usize / channels.max(1);
    let mut samples = Vec::with_capacity(capacity);

    match spec.sample_format {
        SampleFormat::Float => {
            if channels == 1 {
                for sample in reader.samples::<f32>() {
                    let value = sample.map_err(|err| {
                        io::Error::new(io::ErrorKind::InvalidData, err.to_string())
                    })?;
                    if value.is_finite() {
                        samples.push(value);
                    }
                }
            } else {
                let mut frame = Vec::with_capacity(channels);
                let mut iter = reader.samples::<f32>();

                loop {
                    frame.clear();
                    for _ in 0..channels {
                        match iter.next() {
                            Some(Ok(value)) => frame.push(value),
                            Some(Err(err)) => {
                                return Err(io::Error::new(
                                    io::ErrorKind::InvalidData,
                                    err.to_string(),
                                ));
                            }
                            None => {
                                if frame.is_empty() {
                                    break;
                                } else {
                                    return Err(io::Error::new(
                                        io::ErrorKind::UnexpectedEof,
                                        "Audio frame truncated",
                                    ));
                                }
                            }
                        }
                    }

                    if frame.is_empty() {
                        break;
                    }

                    let mut sum = 0.0f32;
                    let mut count = 0usize;
                    for value in &frame {
                        if value.is_finite() {
                            sum += *value;
                            count += 1;
                        }
                    }

                    if count > 0 {
                        samples.push(sum / count as f32);
                    }
                }
            }
        }
        SampleFormat::Int => {
            if spec.bits_per_sample != 16 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("Unsupported PCM bit depth: {}", spec.bits_per_sample),
                ));
            }

            let scale = i16::MAX as f32;

            if channels == 1 {
                for sample in reader.samples::<i16>() {
                    let value = sample.map_err(|err| {
                        io::Error::new(io::ErrorKind::InvalidData, err.to_string())
                    })? as f32
                        / scale;
                    samples.push(value.clamp(-1.0, 1.0));
                }
            } else {
                let mut frame = Vec::with_capacity(channels);
                let mut iter = reader.samples::<i16>();

                loop {
                    frame.clear();
                    for _ in 0..channels {
                        match iter.next() {
                            Some(Ok(value)) => frame.push(value),
                            Some(Err(err)) => {
                                return Err(io::Error::new(
                                    io::ErrorKind::InvalidData,
                                    err.to_string(),
                                ));
                            }
                            None => {
                                if frame.is_empty() {
                                    break;
                                } else {
                                    return Err(io::Error::new(
                                        io::ErrorKind::UnexpectedEof,
                                        "Audio frame truncated",
                                    ));
                                }
                            }
                        }
                    }

                    if frame.is_empty() {
                        break;
                    }

                    let mut sum = 0.0f32;
                    let mut count = 0usize;

                    for value in &frame {
                        sum += (*value as f32) / scale;
                        count += 1;
                    }

                    if count > 0 {
                        samples.push((sum / count as f32).clamp(-1.0, 1.0));
                    }
                }
            }
        }
    }

    if samples.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Audio file did not contain usable samples",
        ));
    }

    Ok((samples, spec.sample_rate))
}
