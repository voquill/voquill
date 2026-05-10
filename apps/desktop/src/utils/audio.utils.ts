import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getAppState } from "../store";
import { AudioSamples } from "../types/audio.types";
import { isLinux, isMacOS, isWindows11 } from "./env.utils";
import { getMyUser } from "./user.utils";
import { getLogger } from "./log.utils";

const writeString = (view: DataView, offset: number, text: string) => {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
};

const floatTo16BitPCM = (
  view: DataView,
  offset: number,
  input: Float32Array,
) => {
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index] ?? 0));
    const value = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(offset + index * 2, value, true);
  }
};

export const ensureFloat32Array = (
  samples: number[] | Float32Array,
): Float32Array =>
  samples instanceof Float32Array ? samples : Float32Array.from(samples ?? []);

export const buildWaveFile = (
  samples: Float32Array,
  sampleRate: number,
): ArrayBuffer => {
  const dataLength = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataLength, true);

  floatTo16BitPCM(view, 44, samples);
  return buffer;
};

export const normalizeSamples = (samples: AudioSamples): number[] =>
  Array.isArray(samples) ? samples : Array.from(samples ?? []);

export const resampleTo16kHz = (
  samples: Float32Array,
  fromRate: number,
): Float32Array => {
  if (fromRate === 16000) return samples;
  const ratio = fromRate / 16000;
  const outputLength = Math.floor(samples.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIdx = i * ratio;
    const srcFloor = Math.floor(srcIdx);
    const srcCeil = Math.min(srcFloor + 1, samples.length - 1);
    const frac = srcIdx - srcFloor;
    output[i] = (samples[srcFloor] ?? 0) * (1 - frac) + (samples[srcCeil] ?? 0) * frac;
  }
  return output;
};

export type AudioClip =
  | "start_recording_clip"
  | "stop_recording_clip"
  | "alert_linux_clip"
  | "alert_macos_clip"
  | "alert_windows_10_clip"
  | "alert_windows_11_clip";

export function tryPlayAudioChime(clip: AudioClip): void {
  const state = getAppState();
  const user = getMyUser(state);
  const playInteractionChime = user?.playInteractionChime ?? true;

  if (!playInteractionChime) {
    return;
  }

  invoke<void>("play_audio", { clip }).catch(console.error);
}

function getAlertClip(): AudioClip {
  if (isMacOS()) {
    return "alert_macos_clip";
  }
  if (isLinux()) {
    return "alert_linux_clip";
  }
  if (isWindows11()) {
    return "alert_windows_11_clip";
  }
  return "alert_windows_10_clip";
}

export function playAlertSound(): void {
  const clip = getAlertClip();
  tryPlayAudioChime(clip);
}

/**
 * Read a WAV file from disk via the Tauri asset protocol and parse it
 * into Float32Array samples. The file must be within the asset protocol scope.
 */
export async function readAudioFromFile(
  filePath: string,
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const assetUrl = convertFileSrc(filePath);
  const response = await fetch(assetUrl);
  if (!response.ok) {
    throw new Error(`Failed to read audio file: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return parseWavBuffer(arrayBuffer);
}

/**
 * Read a WAV file from disk as a raw ArrayBuffer (for direct API upload).
 */
export async function readAudioFileAsBuffer(
  filePath: string,
): Promise<ArrayBuffer> {
  const assetUrl = convertFileSrc(filePath);
  const response = await fetch(assetUrl);
  if (!response.ok) {
    throw new Error(`Failed to read audio file: ${response.status}`);
  }
  return response.arrayBuffer();
}

/** Parse a standard PCM WAV buffer into Float32Array samples. */
function parseWavBuffer(buffer: ArrayBuffer): {
  samples: Float32Array;
  sampleRate: number;
} {
  if (buffer.byteLength < 44) {
    throw new Error(
      `Invalid WAV file: too small (${buffer.byteLength} bytes, minimum 44)`,
    );
  }

  const view = new DataView(buffer);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataSize = view.getUint32(40, true);

  if (bitsPerSample !== 16) {
    getLogger().warning(
      `[audio] unexpected bits per sample: ${bitsPerSample}, expected 16`,
    );
  }

  const bytesPerSample = bitsPerSample / 8;
  const sampleCount = Math.floor(dataSize / bytesPerSample);
  const requiredSize = 44 + dataSize;
  if (buffer.byteLength < requiredSize) {
    throw new Error(
      `WAV data truncated: expected ${requiredSize} bytes, got ${buffer.byteLength}`,
    );
  }

  const samples = new Float32Array(sampleCount);
  const dataOffset = 44;

  for (let i = 0; i < sampleCount; i++) {
    const int16 = view.getInt16(dataOffset + i * 2, true);
    samples[i] = int16 / 32768;
  }

  return { samples, sampleRate };
}

/** Delete a temporary recording file via Rust command. */
export async function cleanupAudioFile(filePath: string): Promise<void> {
  if (!filePath) return;
  try {
    await invoke("cleanup_audio_file", { filePath });
  } catch (error) {
    getLogger().verbose(`[audio] cleanup_audio_file failed: ${error}`);
  }
}
