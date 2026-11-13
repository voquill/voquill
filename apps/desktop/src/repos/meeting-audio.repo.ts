import { invoke } from "@tauri-apps/api/core";
import type { Nullable } from "@voquill/types";
import { BaseRepo } from "./base.repo";

export const MEETING_CAPTURE_PROGRESS_EVENT = "meeting_capture_progress";
export const MEETING_AUDIO_SAMPLE_RATE = 16_000;

export type MeetingCaptureStatus = {
  noteId: string;
  segmentId: string;
  audioPath: string;
  durationMs: number;
  level: number;
  /** Audio stopped arriving; everything captured so far is on disk. */
  interrupted: boolean;
};

export type MeetingCaptureStopped = {
  noteId: string;
  segmentId: string;
  audioPath: string;
  durationMs: number;
};

export const decodePcm16Base64 = (base64: string): Float32Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const view = new DataView(bytes.buffer);
  const samples = new Float32Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }
  return samples;
};

/** Meeting microphone capture and the segment audio files it writes. */
export class MeetingAudioRepo extends BaseRepo {
  async startCapture(args: {
    noteId: string;
    segmentId: string;
    preferredMicrophone: Nullable<string>;
  }): Promise<MeetingCaptureStatus> {
    return invoke<MeetingCaptureStatus>("meeting_capture_start", { args });
  }

  async stopCapture(): Promise<Nullable<MeetingCaptureStopped>> {
    return invoke<Nullable<MeetingCaptureStopped>>("meeting_capture_stop");
  }

  async getCaptureStatus(): Promise<Nullable<MeetingCaptureStatus>> {
    return invoke<Nullable<MeetingCaptureStatus>>("meeting_capture_status");
  }

  /** Makes an interrupted segment file valid again; returns its duration. */
  async repairSegment(audioPath: string): Promise<number> {
    return invoke<number>("meeting_audio_repair", { path: audioPath });
  }

  async getEnvelope(audioPath: string, windowMs: number): Promise<number[]> {
    return invoke<number[]>("meeting_audio_envelope", {
      path: audioPath,
      windowMs,
    });
  }

  async readSamples(
    audioPath: string,
    startMs: number,
    endMs: number,
  ): Promise<Float32Array> {
    const base64 = await invoke<string>("meeting_audio_read", {
      path: audioPath,
      startMs: Math.floor(startMs),
      endMs: Math.ceil(endMs),
    });
    return decodePcm16Base64(base64);
  }

  async deleteSegmentAudio(audioPath: string): Promise<void> {
    await invoke<void>("meeting_audio_delete", { path: audioPath });
  }
}
