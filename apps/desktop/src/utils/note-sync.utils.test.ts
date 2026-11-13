import type { Note, NoteSegment } from "@voquill/types";
import { describe, expect, it } from "vitest";
import type { ServerNote, ServerNoteSegment } from "../repos/cloud-note.repo";
import {
  canRemoveMissingCloudNote,
  mergeNoteSearchResults,
  mergeServerNote,
  mergeServerSegments,
  needsFullNoteFetch,
} from "./note-sync.utils";

const server = (overrides: Partial<ServerNote> = {}): ServerNote => ({
  id: "n",
  title: "AI title",
  titleSource: "ai",
  status: "ready",
  error: null,
  source: "recording",
  personalNotes: "server notes",
  generatedNotes: "Generated.",
  durationMs: 5_000,
  createdAt: "2026-05-01T12:00:00.000Z",
  updatedAt: "2026-05-01T13:00:00.000Z",
  ...overrides,
});

const local = (overrides: Partial<Note> = {}): Note => ({
  id: "n",
  storage: "cloud",
  status: "ready",
  title: "My title",
  titleSource: "user",
  error: null,
  source: "recording",
  personalNotes: "typed offline",
  generatedNotes: "Old.",
  durationMs: 5_000,
  createdAt: "2026-05-01T12:00:00.000Z",
  updatedAt: "2026-05-01T12:30:00.000Z",
  cloud: {
    ownerUserId: "u1",
    onServer: true,
    unsyncedFields: [],
    processRequestedAt: null,
    serverUpdatedAt: null,
    fetchedUpdatedAt: null,
  },
  ...overrides,
});

const segment = (overrides: Partial<NoteSegment> = {}): NoteSegment => ({
  id: "s1",
  noteId: "n",
  index: 0,
  kind: "audio",
  status: "recorded",
  error: null,
  durationMs: 1_000,
  createdAt: "2026-05-01T12:00:00.000Z",
  transcript: null,
  transcribedMs: 0,
  audioPath: "/audio/s1.wav",
  upload: null,
  ...overrides,
});

describe("mergeServerNote", () => {
  it("takes server fields and AI output for a new note (e.g. from mobile)", () => {
    const merged = mergeServerNote(null, server({ status: "draft" }), "u1");
    expect(merged).toMatchObject({
      storage: "cloud",
      status: "paused",
      title: "AI title",
      personalNotes: "server notes",
      cloud: {
        ownerUserId: "u1",
        onServer: true,
        serverUpdatedAt: "2026-05-01T13:00:00.000Z",
      },
    });
  });

  it("keeps unsynced edits but takes the server's AI fields", () => {
    const merged = mergeServerNote(
      local({
        cloud: {
          ...local().cloud!,
          unsyncedFields: ["title", "personalNotes"],
        },
      }),
      server(),
      "u1",
    );
    expect(merged).toMatchObject({
      title: "My title",
      titleSource: "user",
      personalNotes: "typed offline",
      generatedNotes: "Generated.",
    });
  });

  it("takes the server's title and notes once edits are confirmed", () => {
    expect(mergeServerNote(local(), server(), "u1")).toMatchObject({
      title: "AI title",
      personalNotes: "server notes",
    });
  });

  it("keeps the status of work still running on this device", () => {
    expect(
      mergeServerNote(local({ status: "recording" }), server(), "u1").status,
    ).toBe("recording");
    expect(
      mergeServerNote(
        local({
          status: "failed",
          error: { code: "word_quota_exceeded", message: "" },
        }),
        server({ status: "draft" }),
        "u1",
      ),
    ).toMatchObject({
      status: "failed",
      error: { code: "word_quota_exceeded" },
    });
  });
});

describe("mergeServerSegments", () => {
  const serverSegment = (
    overrides: Partial<ServerNoteSegment> = {},
  ): ServerNoteSegment => ({
    id: "s1",
    index: 0,
    kind: "audio",
    status: "transcribed",
    error: null,
    durationMs: 1_200,
    createdAt: "2026-05-01T12:00:00.000Z",
    transcript: { text: "hello", utterances: [] },
    ...overrides,
  });

  it("keeps local audio and uploads, and local-only segments", () => {
    const merged = mergeServerSegments(
      "n",
      [segment(), segment({ id: "s2", index: 1, status: "recording" })],
      [
        serverSegment(),
        serverSegment({ id: "import", index: 2, kind: "import" }),
      ],
    );
    expect(merged.map((s) => [s.id, s.status, s.audioPath])).toEqual([
      ["s1", "transcribed", "/audio/s1.wav"],
      ["s2", "recording", "/audio/s1.wav"],
      ["n-import", "transcribed", null],
    ]);
    expect(merged[0]).toMatchObject({
      durationMs: 1_200,
      transcribedMs: 1_200,
    });
  });
});

describe("canRemoveMissingCloudNote", () => {
  it("removes a synced note without local work", () => {
    expect(
      canRemoveMissingCloudNote(local(), [segment({ audioPath: null })]),
    ).toBe(true);
  });

  it.each([
    ["it has audio the server never transcribed", local(), [segment()]],
    [
      "it never reached the server",
      local({ cloud: { ...local().cloud!, onServer: false } }),
      [],
    ],
    ["it is recording", local({ status: "recording" }), []],
    ["it waits to be sent", local({ status: "pending" }), []],
  ])("keeps it when %s", (_label, note, segments) => {
    expect(canRemoveMissingCloudNote(note, segments)).toBe(false);
  });
});

describe("mergeNoteSearchResults", () => {
  it("puts server results first and drops local duplicates", () => {
    const result = (id: string, snippet: string) => ({
      note: local({ id }),
      snippet,
      score: 1,
    });
    expect(
      mergeNoteSearchResults(
        [result("a", "server a"), result("b", "server b")],
        [result("b", "local b"), result("c", "local c")],
      ).map((r) => r.snippet),
    ).toEqual(["server a", "server b", "local c"]);
  });
});

describe("needsFullNoteFetch", () => {
  it("fetches when the cached segments are older than the server note", () => {
    expect(needsFullNoteFetch(local())).toBe(true);
    expect(
      needsFullNoteFetch(
        local({
          cloud: {
            ...local().cloud!,
            serverUpdatedAt: "x",
            fetchedUpdatedAt: "x",
          },
        }),
      ),
    ).toBe(false);
    expect(needsFullNoteFetch(local({ cloud: null, storage: "local" }))).toBe(
      false,
    );
  });
});
