import type { NoteSegment, NoteTranscript } from "@voquill/types";
import { NOTE_SERVER_LIMITS } from "../repos/cloud-note.repo";

export const NOTE_ENVELOPE_WINDOW_MS = 100;

/**
 * Chunk bounds for transcribing long meeting audio. Chunks stay under five
 * minutes so no provider has to split them again at an arbitrary point
 * (Voquill cloud accepts up to 300 s per request); the transcribe repos still
 * split chunks to their own limits.
 */
export const NOTE_CHUNK_MIN_MS = 180_000;
export const NOTE_CHUNK_MAX_MS = 285_000;

export type NoteChunkLimits = { minMs: number; maxMs: number };

export const DEFAULT_NOTE_CHUNK_LIMITS: NoteChunkLimits = {
  minMs: NOTE_CHUNK_MIN_MS,
  maxMs: NOTE_CHUNK_MAX_MS,
};

/**
 * Short chunks for on-device Whisper, which dictation shares: a dictation
 * never waits behind more than one short note chunk.
 */
export const LOCAL_WHISPER_NOTE_CHUNK_LIMITS: NoteChunkLimits = {
  minMs: 20_000,
  maxMs: 30_000,
};

/** Pauses are judged on a moving average so a gap between words is ignored. */
const PAUSE_SMOOTHING_WINDOWS = 5;

/** Chunks quieter than this everywhere hold no speech and are not sent. */
const SILENT_CHUNK_RMS = 0.002;

export type NoteAudioChunk = {
  startMs: number;
  endMs: number;
};

const smoothEnvelope = (envelope: number[]): number[] => {
  const half = Math.floor(PAUSE_SMOOTHING_WINDOWS / 2);
  return envelope.map((_, index) => {
    const from = Math.max(0, index - half);
    const to = Math.min(envelope.length, index + half + 1);
    let sum = 0;
    for (let i = from; i < to; i++) {
      sum += envelope[i];
    }
    return sum / (to - from);
  });
};

/**
 * Splits `[fromMs, durationMs)` into chunks no longer than the max, cutting
 * each at the quietest moment between the min and max length so speech is
 * not cut mid-word. Planning from `fromMs` lets an interrupted segment resume
 * after its last committed chunk.
 */
export const planNoteAudioChunks = ({
  envelope,
  windowMs,
  fromMs,
  durationMs,
  limits = DEFAULT_NOTE_CHUNK_LIMITS,
}: {
  envelope: number[];
  windowMs: number;
  fromMs: number;
  durationMs: number;
  limits?: NoteChunkLimits;
}): NoteAudioChunk[] => {
  const smoothed = smoothEnvelope(envelope);
  const chunks: NoteAudioChunk[] = [];
  let cursor = Math.max(0, fromMs);

  while (durationMs - cursor > limits.maxMs) {
    const firstWindow = Math.ceil((cursor + limits.minMs) / windowMs);
    const lastWindow = Math.floor((cursor + limits.maxMs) / windowMs) - 1;
    let cutMs = cursor + limits.maxMs;
    let quietest = Number.POSITIVE_INFINITY;
    for (
      let window = firstWindow;
      window <= lastWindow && window < smoothed.length;
      window++
    ) {
      if (smoothed[window] < quietest) {
        quietest = smoothed[window];
        cutMs = window * windowMs + windowMs / 2;
      }
    }
    chunks.push({ startMs: cursor, endMs: cutMs });
    cursor = cutMs;
  }

  if (durationMs > cursor) {
    chunks.push({ startMs: cursor, endMs: durationMs });
  }
  return chunks;
};

export const isNoteAudioChunkSilent = ({
  envelope,
  windowMs,
  chunk,
}: {
  envelope: number[];
  windowMs: number;
  chunk: NoteAudioChunk;
}): boolean => {
  const from = Math.floor(chunk.startMs / windowMs);
  const to = Math.min(envelope.length, Math.ceil(chunk.endMs / windowMs));
  for (let i = from; i < to; i++) {
    if (envelope[i] >= SILENT_CHUNK_RMS) {
      return false;
    }
  }
  return true;
};

const PARAGRAPH_SEPARATOR = "\n\n";

/** Adds a transcribed chunk to a segment transcript (chunks are cut at pauses, so they join without overlap). */
export const appendChunkTranscript = (
  transcript: NoteTranscript | null,
  chunk: NoteAudioChunk,
  text: string,
): NoteTranscript => {
  const utterances = [...(transcript?.utterances ?? [])];
  const trimmed = text.trim();
  if (trimmed) {
    utterances.push({
      startMs: chunk.startMs,
      endMs: chunk.endMs,
      speaker: null,
      text: trimmed,
    });
  }
  return {
    text: utterances
      .map((utterance) => utterance.text)
      .join(PARAGRAPH_SEPARATOR),
    utterances,
  };
};

/** The note transcript: segment transcripts in index order. */
export const buildNoteTranscriptText = (segments: NoteSegment[]): string =>
  [...segments]
    .sort((left, right) => left.index - right.index)
    .map((segment) => segment.transcript?.text.trim() ?? "")
    .filter(Boolean)
    .join(PARAGRAPH_SEPARATOR);

/**
 * A segment rolls over to a new file well before the smallest server cap
 * (free plan 120 MB; ~59 minutes of WAV), so no segment is ever refused.
 * The same limits apply to local notes, so both behave alike.
 */
export const NOTE_SEGMENT_ROLL_MS = 55 * 60_000;
/** Recording stops before a note reaches the server's 8-hour cap. */
export const NOTE_RECORDING_LIMIT_MS =
  NOTE_SERVER_LIMITS.maxNoteMs - 10 * 60_000;
const RESUME_HEADROOM_MS = 60_000;

export type NoteCaptureAction = "roll" | "stop" | null;

/** What a running capture must do now to stay within the limits. */
export const getNoteCaptureAction = ({
  noteElapsedMs,
  segmentMs,
  segmentCount,
}: {
  noteElapsedMs: number;
  segmentMs: number;
  segmentCount: number;
}): NoteCaptureAction => {
  if (noteElapsedMs >= NOTE_RECORDING_LIMIT_MS) return "stop";
  if (segmentMs >= NOTE_SEGMENT_ROLL_MS) {
    return segmentCount >= NOTE_SERVER_LIMITS.maxSegments ? "stop" : "roll";
  }
  return null;
};

/**
 * A paused recording continues in its last segment while that file has not
 * been sent anywhere, so pausing never uses up segments.
 */
export const canAppendToNoteSegment = (segment: NoteSegment | undefined) =>
  segment !== undefined &&
  segment.kind === "audio" &&
  segment.status === "recorded" &&
  segment.audioPath !== null &&
  segment.upload === null &&
  segment.transcribedMs === 0 &&
  segment.durationMs < NOTE_SEGMENT_ROLL_MS - RESUME_HEADROOM_MS;

export type NoteResumeBlocker = "note_length_limit" | "too_many_segments";

export const getNoteResumeBlocker = ({
  noteElapsedMs,
  segments,
}: {
  noteElapsedMs: number;
  segments: NoteSegment[];
}): NoteResumeBlocker | null => {
  if (noteElapsedMs >= NOTE_RECORDING_LIMIT_MS - RESUME_HEADROOM_MS) {
    return "note_length_limit";
  }
  const last = [...segments].sort((a, b) => b.index - a.index)[0];
  if (
    !canAppendToNoteSegment(last) &&
    segments.length >= NOTE_SERVER_LIMITS.maxSegments
  ) {
    return "too_many_segments";
  }
  return null;
};
