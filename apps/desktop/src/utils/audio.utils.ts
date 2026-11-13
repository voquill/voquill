import { invoke } from "@tauri-apps/api/core";
import { getAppState } from "../store";
import { AudioSamples } from "../types/audio.types";
import { isLinux, isMacOS, isWindows11 } from "./env.utils";
import { getMyUser } from "./user.utils";
import { getIsMeetingCapturing } from "./note.utils";

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

  if (!playInteractionChime || getIsMeetingCapturing(state)) {
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
