import type { NoteSegment } from "@voquill/types";
import { formatNoteDuration, getNoteSegmentOffsetsMs } from "./note.utils";

export type NoteTranscriptEntry = {
  key: string;
  /** From the start of the note; null when not timed (imports). */
  startMs: number | null;
  /** 0-based diarization label, or null. */
  speaker: number | null;
  text: string;
};

/** The note's transcript as display/copy entries, timed from the note start. */
export const getNoteTranscriptEntries = (
  segments: NoteSegment[],
): NoteTranscriptEntry[] => {
  const offsets = getNoteSegmentOffsetsMs(segments);
  return segments.flatMap((segment): NoteTranscriptEntry[] => {
    const transcript = segment.transcript;
    if (!transcript) {
      return [];
    }
    if (transcript.utterances.length === 0) {
      if (!transcript.text.trim()) {
        return [];
      }
      return [
        {
          key: segment.id,
          startMs: null,
          speaker: null,
          text: transcript.text,
        },
      ];
    }
    const offset = offsets.get(segment.id) ?? 0;
    return transcript.utterances
      .filter((utterance) => utterance.text.trim())
      .map((utterance, index) => ({
        key: `${segment.id}-${index}`,
        startMs: offset + utterance.startMs,
        speaker: utterance.speaker,
        text: utterance.text.trim(),
      }));
  });
};

/**
 * Plain text for the clipboard: one paragraph per entry, prefixed with the
 * time and speaker when known, e.g. `[12:04] Speaker 2: Sounds good.`
 */
export const formatNoteTranscriptForCopy = (
  entries: NoteTranscriptEntry[],
  speakerLabel: (speaker: number) => string,
): string =>
  entries
    .map((entry) => {
      const prefix = [
        entry.startMs !== null
          ? `[${formatNoteDuration(entry.startMs)}]`
          : null,
        entry.speaker !== null ? `${speakerLabel(entry.speaker)}:` : null,
      ]
        .filter(Boolean)
        .join(" ");
      return prefix ? `${prefix} ${entry.text}` : entry.text;
    })
    .join("\n\n");
