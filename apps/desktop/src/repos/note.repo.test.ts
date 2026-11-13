import type { Note, NoteSegment } from "@voquill/types";
import { describe, expect, it } from "vitest";
import {
  fromLocalNote,
  fromLocalNoteSegment,
  toLocalNote,
  toLocalNoteSegment,
} from "./note.repo";

const note: Note = {
  id: "note-1",
  storage: "local",
  status: "failed",
  title: "Planning",
  titleSource: "user",
  error: { code: "transcription_failed", message: "offline" },
  source: "recording",
  personalNotes: "mine",
  generatedNotes: null,
  durationMs: 61_000,
  createdAt: "2026-03-04T05:06:07.000Z",
  updatedAt: "2026-03-04T05:16:07.000Z",
  cloud: null,
};

const segment: NoteSegment = {
  id: "seg-1",
  noteId: "note-1",
  index: 2,
  kind: "audio",
  status: "recorded",
  durationMs: 30_000,
  createdAt: "2026-03-04T05:06:07.000Z",
  transcript: {
    text: "hello",
    utterances: [{ startMs: 0, endMs: 1_000, speaker: null, text: "hello" }],
  },
  transcribedMs: 1_000,
  audioPath: "/data/meeting-audio/note-1/seg-1.wav",
  error: null,
  upload: null,
};

describe("note repo mapping", () => {
  it("round-trips a note through the local shape", () => {
    const local = toLocalNote(note);
    expect(local).toMatchObject({
      errorCode: "transcription_failed",
      errorMessage: "offline",
      createdAt: Date.parse(note.createdAt),
      updatedAt: Date.parse(note.updatedAt),
    });
    expect(fromLocalNote(local)).toEqual(note);
  });

  it("maps a missing error code to no error", () => {
    expect(
      fromLocalNote({ ...toLocalNote(note), errorCode: null }).error,
    ).toBeNull();
  });

  it("round-trips a segment with its utterances", () => {
    const local = toLocalNoteSegment(segment);
    expect(local.segmentIndex).toBe(2);
    expect(local.transcriptText).toBe("hello");
    expect(JSON.parse(local.transcriptUtterances ?? "")).toEqual(
      segment.transcript?.utterances,
    );
    expect(fromLocalNoteSegment(local)).toEqual(segment);
  });

  it("keeps an untranscribed segment without a transcript", () => {
    const local = toLocalNoteSegment({ ...segment, transcript: null });
    expect(local.transcriptText).toBeNull();
    expect(fromLocalNoteSegment(local).transcript).toBeNull();
  });

  it("tolerates corrupt utterance JSON", () => {
    const local = { ...toLocalNoteSegment(segment), transcriptUtterances: "{" };
    expect(fromLocalNoteSegment(local).transcript).toEqual({
      text: "hello",
      utterances: [],
    });
  });
});
