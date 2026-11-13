import { invoke } from "@tauri-apps/api/core";
import type { Nullable } from "@voquill/types";
import { BaseRepo } from "./base.repo";

export const MEETING_CAPTURE_PROGRESS_EVENT = "meeting_capture_progress";
export const RESUMABLE_UPLOAD_PROGRESS_EVENT = "resumable_upload_progress";
export const MEETING_AUDIO_SAMPLE_RATE = 16_000;

/**
 * Why audio stopped arriving: the device stopped, the disk refused or
 * stalled, or the device changed its format (the capture is restarted).
 */
export type MeetingCaptureInterruption =
  | "no-audio"
  | "write-failed"
  | "device-changed";

export type MeetingCaptureStatus = {
  noteId: string;
  segmentId: string;
  audioPath: string;
  /** The whole segment file, including audio it held before this capture. */
  durationMs: number;
  /** What the segment file held when this capture started appending. */
  initialDurationMs: number;
  level: number;
  /** Why audio stopped arriving; everything captured so far is on disk. */
  interruption: MeetingCaptureInterruption | null;
  /** Only silence has arrived for a while (muted, blocked or wrong microphone). */
  silent: boolean;
};

export type MeetingCaptureRolled = {
  finished: MeetingCaptureStopped;
  status: MeetingCaptureStatus;
};

export type UnreferencedMeetingAudio = {
  noteId: string;
  segmentId: string;
  audioPath: string;
  durationMs: number;
  /** A note with this id exists on this device (for any account). */
  noteExists: boolean;
};

export type MeetingCaptureStopped = {
  noteId: string;
  segmentId: string;
  audioPath: string;
  durationMs: number;
};

export type ResumableUploadOutcome = {
  outcome:
    | "complete"
    | "partial"
    | "expired"
    | "interrupted"
    | "rejected"
    | "cancelled";
  uploadedBytes: number;
  totalBytes: number;
  status: number | null;
  message: string | null;
};

export type ResumableUploadProgress = {
  uploadId: string;
  uploadedBytes: number;
  totalBytes: number;
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
  /** Starts capturing into a new segment, or `append`s to an existing one. */
  async startCapture(args: {
    noteId: string;
    segmentId: string;
    append: boolean;
    preferredMicrophone: Nullable<string>;
  }): Promise<MeetingCaptureStatus> {
    return invoke<MeetingCaptureStatus>("meeting_capture_start", { args });
  }

  /** Continues the running capture in a new segment, with no gap. */
  async rollCapture(
    noteId: string,
    segmentId: string,
  ): Promise<MeetingCaptureRolled> {
    return invoke<MeetingCaptureRolled>("meeting_capture_roll", {
      noteId,
      segmentId,
    });
  }

  /** Segment files on disk that no stored segment references. */
  async listUnreferencedAudio(): Promise<UnreferencedMeetingAudio[]> {
    return invoke<UnreferencedMeetingAudio[]>("meeting_audio_unreferenced");
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

  async getFileSize(audioPath: string): Promise<number> {
    return invoke<number>("meeting_audio_file_size", { path: audioPath });
  }

  /**
   * One pass of a resumable upload of a segment file: resumes from what the
   * session already has. Progress arrives as `RESUMABLE_UPLOAD_PROGRESS_EVENT`.
   */
  async uploadResumable(args: {
    uploadId: string;
    filePath: string;
    url: string;
    contentType: string;
    /** Stop after about this many bytes so the caller can yield between passes. */
    maxBytes: number | null;
  }): Promise<ResumableUploadOutcome> {
    return invoke<ResumableUploadOutcome>("resumable_upload", {
      args: {
        uploadId: args.uploadId,
        filePath: args.filePath,
        url: args.url,
        headers: [{ name: "Content-Type", value: args.contentType }],
        maxBytes: args.maxBytes,
      },
    });
  }

  async cancelUpload(uploadId: string): Promise<void> {
    await invoke<void>("resumable_upload_cancel", { uploadId });
  }
}
