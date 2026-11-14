import type { NoteSegment } from "@voquill/types";
import { describe, expect, it } from "vitest";
import {
  formatNoteTranscriptForCopy,
  getNoteTranscriptEntries,
} from "./note-transcript.utils";

const segment = (
  index: number,
  durationMs: number,
  transcript: NoteSegment["transcript"],
): NoteSegment => ({
  id: `s${index}`,
  noteId: "n",
  index,
  kind: "audio",
  status: "transcribed",
  error: null,
  durationMs,
  createdAt: "2026-01-01T00:00:00.000Z",
  transcript,
  transcribedMs: durationMs,
  audioPath: null,
  upload: null,
});

const label = (speaker: number) => `Speaker ${speaker + 1}`;

describe("transcript copy", () => {
  it("prefixes timed turns with the time from the note start and the speaker", () => {
    const entries = getNoteTranscriptEntries([
      segment(0, 60_000, {
        text: "",
        utterances: [
          { startMs: 0, endMs: 1_000, speaker: 0, text: "Hello." },
          { startMs: 2_000, endMs: 3_000, speaker: null, text: " " },
        ],
      }),
      segment(1, 30_000, {
        text: "",
        utterances: [
          { startMs: 5_000, endMs: 6_000, speaker: 1, text: "Hi there." },
        ],
      }),
    ]);
    expect(formatNoteTranscriptForCopy(entries, label)).toBe(
      "[0:00] Speaker 1: Hello.\n\n[1:05] Speaker 2: Hi there.",
    );
  });

  it("keeps untimed text (imports) and local chunks without speakers", () => {
    const entries = getNoteTranscriptEntries([
      segment(0, 0, { text: "Alice: pasted\nBob: text", utterances: [] }),
      segment(1, 40_000, {
        text: "",
        utterances: [
          {
            startMs: 30_000,
            endMs: 40_000,
            speaker: null,
            text: "Local chunk.",
          },
        ],
      }),
    ]);
    expect(formatNoteTranscriptForCopy(entries, label)).toBe(
      "Alice: pasted\nBob: text\n\n[0:30] Local chunk.",
    );
  });

  it("formats hours for long meetings", () => {
    const entries = getNoteTranscriptEntries([
      segment(0, 2 * 3_600_000, {
        text: "",
        utterances: [
          { startMs: 3_725_000, endMs: 3_726_000, speaker: 0, text: "Late." },
        ],
      }),
    ]);
    expect(formatNoteTranscriptForCopy(entries, label)).toBe(
      "[1:02:05] Speaker 1: Late.",
    );
  });
});
