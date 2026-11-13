import type { NoteSegment, NoteTranscript } from "@voquill/types";

export const NOTE_ENVELOPE_WINDOW_MS = 100;

/**
 * Chunk bounds for transcribing long meeting audio. Chunks stay under five
 * minutes so no provider has to split them again at an arbitrary point
 * (Voquill cloud accepts up to 300 s per request); the transcribe repos still
 * split chunks to their own limits.
 */
export const NOTE_CHUNK_MIN_MS = 180_000;
export const NOTE_CHUNK_MAX_MS = 285_000;

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
}: {
  envelope: number[];
  windowMs: number;
  fromMs: number;
  durationMs: number;
}): NoteAudioChunk[] => {
  const smoothed = smoothEnvelope(envelope);
  const chunks: NoteAudioChunk[] = [];
  let cursor = Math.max(0, fromMs);

  while (durationMs - cursor > NOTE_CHUNK_MAX_MS) {
    const firstWindow = Math.ceil((cursor + NOTE_CHUNK_MIN_MS) / windowMs);
    const lastWindow = Math.floor((cursor + NOTE_CHUNK_MAX_MS) / windowMs) - 1;
    let cutMs = cursor + NOTE_CHUNK_MAX_MS;
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
