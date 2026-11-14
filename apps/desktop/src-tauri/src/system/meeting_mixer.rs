//! Mixes system audio into the microphone's timeline for a meeting segment.
//!
//! The microphone is the clock. Each microphone chunk is resampled and written
//! as soon as it arrives, and the file is exactly as long as the microphone
//! audio, so system audio can never hold the microphone back or cut it short.
//! System audio is resampled to 16 kHz into a queue that the microphone
//! consumes sample for sample. The writer feeds the queue only with system
//! audio that arrived before each microphone chunk, which lines the two up by
//! arrival time (within one device buffer, about 10 to 20 ms).
//!
//! The queue keeps about `SYSTEM_DELAY` of system audio in reserve, so the
//! jitter in when the two devices deliver never cuts gaps into the system
//! audio. The devices run on separate clocks and drift apart (tens to
//! hundreds of ppm, up to a second over a few hours); whenever the reserve
//! leaves its band, one system sample in a thousand is dropped or repeated,
//! which is inaudible in speech and keeps up with up to 1000 ppm of drift.
//! System audio more than `SYSTEM_BACKLOG_LIMIT` behind (a source catching up
//! after a stall) is discarded at once. When the queue runs dry (nothing
//! playing on a source that then goes quiet, a stalled or failed source) the
//! system side is silent, and the reserve is rebuilt when audio returns.
//!
//! The sum goes through a soft knee: below `LIMITER_THRESHOLD` audio passes
//! untouched, above it peaks bend smoothly towards full scale, and even two
//! full-scale signals added together stay below it. A fixed gain would also prevent clipping, but would make every meeting
//! 6 dB quieter, including microphone-only ones; the knee only touches the
//! rare peaks where both sides are loud at once.

use std::collections::VecDeque;

use crate::system::meeting_audio::{to_pcm16, Downsampler, MEETING_SAMPLE_RATE};

const fn ms_to_samples(ms: usize) -> usize {
    ms * MEETING_SAMPLE_RATE as usize / 1_000
}

const SYSTEM_DELAY: usize = ms_to_samples(50);
const SYSTEM_DELAY_TOLERANCE: usize = ms_to_samples(25);
const SYSTEM_BACKLOG_LIMIT: usize = ms_to_samples(500);
const DRIFT_CORRECTION_DIVISOR: usize = 1_000;
const LIMITER_THRESHOLD: f32 = 0.5;

pub struct MeetingMixer {
    microphone: Downsampler,
    microphone_out: Vec<f32>,
    /// The system resampler and the rate it was built for.
    system: Option<(u32, Downsampler)>,
    system_out: Vec<f32>,
    system_queue: VecDeque<f32>,
    system_block: Vec<f32>,
    /// The reserve is built and system audio is keeping up with the microphone.
    system_flowing: bool,
}

impl MeetingMixer {
    pub fn new(microphone_rate: u32) -> Self {
        Self {
            microphone: Downsampler::new(microphone_rate),
            microphone_out: Vec::new(),
            system: None,
            system_out: Vec::new(),
            system_queue: VecDeque::new(),
            system_block: Vec::new(),
            system_flowing: false,
        }
    }

    /// Queues system audio that arrived before the next microphone chunk.
    pub fn push_system(&mut self, samples: &[f32], sample_rate: u32) {
        if sample_rate == 0 {
            return;
        }
        if self.system.as_ref().map(|(rate, _)| *rate) != Some(sample_rate) {
            if let Some((_, mut previous)) = self.system.take() {
                self.system_out.clear();
                previous.flush(&mut self.system_out);
                self.system_queue.extend(self.system_out.iter());
            }
            self.system = Some((sample_rate, Downsampler::new(sample_rate)));
        }
        if let Some((_, resampler)) = self.system.as_mut() {
            self.system_out.clear();
            resampler.process(samples, &mut self.system_out);
            self.system_queue.extend(self.system_out.iter());
        }
    }

    /// Resamples microphone audio, adds the system audio of the same moment
    /// and appends the 16-bit result to `output`.
    pub fn mix_microphone(&mut self, samples: &[f32], output: &mut Vec<i16>) {
        self.microphone_out.clear();
        self.microphone.process(samples, &mut self.microphone_out);
        self.mix_into(output);
    }

    /// The microphone audio still waiting for resampler lookahead.
    pub fn flush(&mut self, output: &mut Vec<i16>) {
        self.microphone_out.clear();
        self.microphone.flush(&mut self.microphone_out);
        self.mix_into(output);
    }

    fn mix_into(&mut self, output: &mut Vec<i16>) {
        let needed = self.microphone_out.len();
        if needed == 0 {
            return;
        }
        self.fill_system_block(needed);
        output.extend(
            self.microphone_out
                .iter()
                .zip(&self.system_block)
                .map(|(microphone, system)| to_pcm16(soft_limit(microphone + system))),
        );
    }

    /// Takes `needed` samples of system audio for the microphone block.
    fn fill_system_block(&mut self, needed: usize) {
        self.system_block.clear();
        let available = self.system_queue.len();
        if available > needed + SYSTEM_BACKLOG_LIMIT {
            self.system_queue.drain(..available - needed - SYSTEM_DELAY);
        }
        let available = self.system_queue.len();

        let mut lead = 0;
        let mut repeat = 0;
        if !self.system_flowing {
            if available < SYSTEM_DELAY {
                // Too little to start with; it waits for more.
                self.system_block.resize(needed, 0.0);
                return;
            }
            // The newest audio lines up with the end of this block, minus the reserve.
            lead = (needed + SYSTEM_DELAY)
                .saturating_sub(available)
                .min(needed);
            self.system_flowing = true;
        } else if available >= needed {
            let reserve = available - needed;
            let step = (needed / DRIFT_CORRECTION_DIVISOR).max(1);
            if reserve > SYSTEM_DELAY + SYSTEM_DELAY_TOLERANCE {
                self.system_queue.drain(..step);
            } else if reserve + SYSTEM_DELAY_TOLERANCE < SYSTEM_DELAY {
                repeat = step;
            }
        }

        self.system_block.resize(lead, 0.0);
        let wanted = needed - lead - repeat;
        let taken = wanted.min(self.system_queue.len());
        self.system_block.extend(self.system_queue.drain(..taken));
        if taken < wanted {
            // Ran dry: silence until the source delivers again.
            self.system_flowing = false;
        } else if repeat > 0 {
            let last = self.system_block.last().copied().unwrap_or(0.0);
            self.system_block.extend(std::iter::repeat_n(last, repeat));
        }
        self.system_block.resize(needed, 0.0);
    }

    #[cfg(test)]
    fn system_reserve(&self) -> usize {
        self.system_queue.len()
    }
}

/// Unity gain below the threshold; above it the level bends towards full
/// scale, with no corner at the threshold.
fn soft_limit(sample: f32) -> f32 {
    let magnitude = sample.abs();
    if magnitude <= LIMITER_THRESHOLD {
        return sample;
    }
    let headroom = 1.0 - LIMITER_THRESHOLD;
    sample.signum()
        * (LIMITER_THRESHOLD + headroom * ((magnitude - LIMITER_THRESHOLD) / headroom).tanh())
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLOCK: usize = 1_600;

    fn sine(rate: u32, hz: f64, amplitude: f64, samples: usize, offset: usize) -> Vec<f32> {
        (offset..offset + samples)
            .map(|i| {
                (amplitude * (2.0 * std::f64::consts::PI * hz * i as f64 / rate as f64).sin())
                    as f32
            })
            .collect()
    }

    fn as_f32(samples: &[i16]) -> Vec<f32> {
        samples
            .iter()
            .map(|value| *value as f32 / i16::MAX as f32)
            .collect()
    }

    /// Amplitude of `hz` in `samples` (16 kHz), by correlation.
    fn tone_amplitude(samples: &[f32], hz: f64) -> f64 {
        let (mut sin, mut cos) = (0.0, 0.0);
        for (i, value) in samples.iter().enumerate() {
            let phase = 2.0 * std::f64::consts::PI * hz * i as f64 / MEETING_SAMPLE_RATE as f64;
            sin += f64::from(*value) * phase.sin();
            cos += f64::from(*value) * phase.cos();
        }
        2.0 * (sin * sin + cos * cos).sqrt() / samples.len() as f64
    }

    #[test]
    fn soft_limit_leaves_normal_levels_alone_and_never_reaches_full_scale() {
        assert_eq!(soft_limit(0.3), 0.3);
        assert_eq!(soft_limit(-0.5), -0.5);
        assert!(soft_limit(0.51) > 0.5 && soft_limit(0.51) < 0.51);
        // Up to two full-scale signals, with resampler overshoot.
        for input in [0.9f32, 1.5, 2.0, 2.2] {
            let output = soft_limit(input);
            assert!(output < 0.999, "{input} -> {output}");
            assert_eq!(soft_limit(-input), -output);
        }
        assert!(soft_limit(100.0) <= 1.0);
        assert!(soft_limit(1.5) > soft_limit(0.9), "it stays monotonic");
    }

    #[test]
    fn both_sources_end_up_in_the_mix_without_clipping() {
        let mut mixer = MeetingMixer::new(48_000);
        let mut output = Vec::new();
        for block in 0..50 {
            for part in 0..10 {
                mixer.push_system(
                    &sine(44_100, 1_000.0, 0.9, 441, (block * 10 + part) * 441),
                    44_100,
                );
            }
            mixer.mix_microphone(&sine(48_000, 300.0, 0.9, 4_800, block * 4_800), &mut output);
        }
        mixer.flush(&mut output);
        assert_eq!(output.len(), 50 * BLOCK, "the file follows the microphone");
        let mixed = as_f32(&output[10 * BLOCK..]);
        assert!(tone_amplitude(&mixed, 300.0) > 0.5);
        assert!(tone_amplitude(&mixed, 1_000.0) > 0.5);
        assert!(
            output
                .iter()
                .all(|value| value.unsigned_abs() < i16::MAX as u16),
            "two full-scale signals never reach full scale"
        );
    }

    #[test]
    fn without_system_audio_the_microphone_passes_through() {
        let mut mixer = MeetingMixer::new(16_000);
        let mut output = Vec::new();
        let microphone = sine(16_000, 440.0, 0.4, BLOCK * 5, 0);
        for block in microphone.chunks(BLOCK) {
            mixer.mix_microphone(block, &mut output);
        }
        let expected: Vec<i16> = microphone.iter().map(|value| to_pcm16(*value)).collect();
        assert_eq!(output, expected);
    }

    #[test]
    fn system_audio_that_stalls_is_silence_and_rejoins_in_step() {
        let mut mixer = MeetingMixer::new(16_000);
        let mut output = Vec::new();
        for block in 0..60 {
            let stalled = (20..40).contains(&block);
            if !stalled {
                for _ in 0..10 {
                    mixer.push_system(&vec![0.25; 160], 16_000);
                }
            }
            mixer.mix_microphone(&vec![0.0; BLOCK], &mut output);
        }
        assert_eq!(output.len(), 60 * BLOCK);
        let level = |block: usize| {
            as_f32(&output[block * BLOCK..(block + 1) * BLOCK])
                .iter()
                .map(|value| value.abs())
                .sum::<f32>()
                / BLOCK as f32
        };
        assert!(level(10) > 0.2, "system audio before the stall");
        assert!(level(30) < 1e-6, "silence while it stalls");
        assert!(level(50) > 0.2, "system audio after it returns");
        assert!(mixer.system_reserve() <= SYSTEM_DELAY + SYSTEM_DELAY_TOLERANCE);
    }

    #[test]
    fn a_system_backlog_after_a_stall_is_discarded_not_mixed_late() {
        let mut mixer = MeetingMixer::new(16_000);
        let mut output = Vec::new();
        for _ in 0..5 {
            mixer.push_system(&vec![0.1; BLOCK], 16_000);
            mixer.mix_microphone(&vec![0.0; BLOCK], &mut output);
        }
        // Two seconds arrive at once.
        mixer.push_system(&vec![0.1; 32_000], 16_000);
        mixer.mix_microphone(&vec![0.0; BLOCK], &mut output);
        assert!(mixer.system_reserve() <= SYSTEM_DELAY + SYSTEM_DELAY_TOLERANCE);
    }

    #[test]
    fn system_rate_changes_mid_meeting_are_followed() {
        let mut mixer = MeetingMixer::new(48_000);
        let mut output = Vec::new();
        for block in 0..40 {
            // A headset switching from 48 kHz to 24 kHz halfway.
            let rate = if block < 20 { 48_000 } else { 24_000 };
            mixer.push_system(
                &sine(
                    rate,
                    500.0,
                    0.3,
                    rate as usize / 10,
                    block * rate as usize / 10,
                ),
                rate,
            );
            mixer.mix_microphone(&vec![0.0; 4_800], &mut output);
        }
        let end = as_f32(&output[30 * BLOCK..]);
        assert!((tone_amplitude(&end, 500.0) - 0.3).abs() < 0.05);
        assert!(mixer.system_reserve() <= SYSTEM_DELAY + SYSTEM_DELAY_TOLERANCE + BLOCK);
    }

    /// Runs `hours` of 100 ms microphone blocks against a system clock
    /// `ppm` off, delivering 10 ms buffers, and returns the largest reserve
    /// seen after the start and how many blocks ran dry.
    fn run_drift(ppm: f64, hours: f64) -> (usize, usize, usize) {
        let mut mixer = MeetingMixer::new(16_000);
        let mut output = Vec::with_capacity(BLOCK);
        let blocks = (hours * 36_000.0) as usize;
        let system_per_block = BLOCK as f64 * (1.0 + ppm / 1e6);
        let mut delivered = 0.0f64;
        let mut max_reserve = 0;
        let mut min_reserve = usize::MAX;
        let mut dry_blocks = 0;
        let buffer = vec![0.2f32; 400];
        for block in 0..blocks {
            let target = system_per_block * (block + 1) as f64;
            while delivered + 160.0 <= target {
                let size = 160.min(buffer.len());
                mixer.push_system(&buffer[..size], 16_000);
                delivered += size as f64;
            }
            output.clear();
            mixer.mix_microphone(&vec![0.0; BLOCK], &mut output);
            if block > 600 {
                let reserve = mixer.system_reserve();
                max_reserve = max_reserve.max(reserve);
                min_reserve = min_reserve.min(reserve);
                if output.iter().any(|value| *value == 0) {
                    dry_blocks += 1;
                }
            }
        }
        (min_reserve, max_reserve, dry_blocks)
    }

    /// 500 ppm for an hour drifts 1.8 s, as much as 100 ppm does in five.
    #[test]
    fn clock_drift_over_an_hour_stays_bounded_without_gaps() {
        for ppm in [-500.0, -100.0, 100.0, 500.0] {
            let (min_reserve, max_reserve, dry_blocks) = run_drift(ppm, 1.0);
            assert!(
                max_reserve <= SYSTEM_DELAY + SYSTEM_DELAY_TOLERANCE + 160,
                "{ppm} ppm: reserve grew to {max_reserve}"
            );
            assert!(
                min_reserve + SYSTEM_DELAY_TOLERANCE + 160 >= SYSTEM_DELAY,
                "{ppm} ppm: reserve fell to {min_reserve}"
            );
            assert_eq!(dry_blocks, 0, "{ppm} ppm: system audio had gaps");
        }
    }
}
