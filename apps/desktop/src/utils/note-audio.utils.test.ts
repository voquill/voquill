import type { NoteSegment } from "@voquill/types";
import { describe, expect, it } from "vitest";
import {
  appendChunkTranscript,
  buildNoteTranscriptText,
  isNoteAudioChunkSilent,
  NOTE_CHUNK_MAX_MS,
  NOTE_CHUNK_MIN_MS,
  planNoteAudioChunks,
} from "./note-audio.utils";

const WINDOW_MS = 100;

const loudEnvelope = (durationMs: number) =>
  Array.from({ length: Math.ceil(durationMs / WINDOW_MS) }, () => 0.2);

describe("planNoteAudioChunks", () => {
  it("keeps short audio in one chunk", () => {
    expect(
      planNoteAudioChunks({
        envelope: loudEnvelope(5_000),
        windowMs: WINDOW_MS,
        fromMs: 0,
        durationMs: 5_000,
      }),
    ).toEqual([{ startMs: 0, endMs: 5_000 }]);
  });

  it("returns nothing for empty or fully transcribed audio", () => {
    const args = { envelope: [], windowMs: WINDOW_MS, durationMs: 0 };
    expect(planNoteAudioChunks({ ...args, fromMs: 0 })).toEqual([]);
    expect(
      planNoteAudioChunks({
        envelope: loudEnvelope(10_000),
        windowMs: WINDOW_MS,
        fromMs: 10_000,
        durationMs: 10_000,
      }),
    ).toEqual([]);
  });

  it("cuts long audio at the quietest pause within the chunk bounds", () => {
    const durationMs = 600_000;
    const envelope = loudEnvelope(durationMs);
    // A one-second pause at 200 s and a brief dip (one window) at 250 s.
    for (let i = 2_000; i < 2_010; i++) envelope[i] = 0.001;
    envelope[2_500] = 0.0;

    const chunks = planNoteAudioChunks({
      envelope,
      windowMs: WINDOW_MS,
      fromMs: 0,
      durationMs,
    });

    expect(chunks[0].startMs).toBe(0);
    expect(chunks[0].endMs).toBeGreaterThanOrEqual(200_000);
    expect(chunks[0].endMs).toBeLessThan(201_000);
    for (const [index, chunk] of chunks.entries()) {
      expect(chunk.endMs - chunk.startMs).toBeLessThanOrEqual(
        NOTE_CHUNK_MAX_MS,
      );
      if (index < chunks.length - 1) {
        expect(chunk.endMs - chunk.startMs).toBeGreaterThanOrEqual(
          NOTE_CHUNK_MIN_MS,
        );
        expect(chunks[index + 1].startMs).toBe(chunk.endMs);
      }
    }
    expect(chunks.at(-1)?.endMs).toBe(durationMs);
  });

  it("cuts at the maximum when there is no envelope for the range", () => {
    const chunks = planNoteAudioChunks({
      envelope: [],
      windowMs: WINDOW_MS,
      fromMs: 0,
      durationMs: 400_000,
    });
    expect(chunks).toEqual([
      { startMs: 0, endMs: NOTE_CHUNK_MAX_MS },
      { startMs: NOTE_CHUNK_MAX_MS, endMs: 400_000 },
    ]);
  });

  it("resumes planning after the committed progress", () => {
    const envelope = loudEnvelope(900_000);
    const all = planNoteAudioChunks({
      envelope,
      windowMs: WINDOW_MS,
      fromMs: 0,
      durationMs: 900_000,
    });
    const resumed = planNoteAudioChunks({
      envelope,
      windowMs: WINDOW_MS,
      fromMs: all[0].endMs,
      durationMs: 900_000,
    });
    expect(resumed).toEqual(all.slice(1));
  });
});

describe("isNoteAudioChunkSilent", () => {
  it("detects chunks without any audible window", () => {
    const envelope = [0, 0.001, 0, 0.5, 0];
    expect(
      isNoteAudioChunkSilent({
        envelope,
        windowMs: WINDOW_MS,
        chunk: { startMs: 0, endMs: 300 },
      }),
    ).toBe(true);
    expect(
      isNoteAudioChunkSilent({
        envelope,
        windowMs: WINDOW_MS,
        chunk: { startMs: 0, endMs: 400 },
      }),
    ).toBe(false);
  });
});

describe("appendChunkTranscript", () => {
  it("stitches chunks into timed utterances and paragraphs", () => {
    let transcript = appendChunkTranscript(
      null,
      { startMs: 0, endMs: 1_000 },
      " Hello there. ",
    );
    transcript = appendChunkTranscript(
      transcript,
      { startMs: 1_000, endMs: 2_000 },
      "",
    );
    transcript = appendChunkTranscript(
      transcript,
      { startMs: 2_000, endMs: 3_000 },
      "General Kenobi.",
    );
    expect(transcript).toEqual({
      text: "Hello there.\n\nGeneral Kenobi.",
      utterances: [
        { startMs: 0, endMs: 1_000, speaker: null, text: "Hello there." },
        {
          startMs: 2_000,
          endMs: 3_000,
          speaker: null,
          text: "General Kenobi.",
        },
      ],
    });
  });
});

describe("buildNoteTranscriptText", () => {
  const segment = (index: number, text: string | null): NoteSegment => ({
    id: `s${index}`,
    noteId: "n",
    index,
    kind: "audio",
    status: "transcribed",
    durationMs: 1_000,
    createdAt: "2026-01-01T00:00:00.000Z",
    transcript: text === null ? null : { text, utterances: [] },
    transcribedMs: 1_000,
    audioPath: null,
  });

  it("joins segment transcripts in index order and skips empty ones", () => {
    expect(
      buildNoteTranscriptText([
        segment(2, "third"),
        segment(0, "first"),
        segment(1, null),
        segment(3, "  "),
      ]),
    ).toBe("first\n\nthird");
  });
});
