import type { Note, NoteSegment } from "@voquill/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingCaptureStatus } from "../repos/meeting-audio.repo";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";

const fakes = vi.hoisted(() => ({
  notes: new Map<string, Note>(),
  segments: new Map<string, NoteSegment>(),
  capture: null as MeetingCaptureStatus | null,
  nativeCapture: null as MeetingCaptureStatus | null,
  repairedPaths: [] as string[],
  processed: [] as string[],
  resumed: [] as string[],
}));

vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    info: () => {},
    warning: () => {},
    error: () => {},
    verbose: () => {},
  }),
}));

vi.mock("../utils/note.utils", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDefaultNoteTitle: () => "Meeting",
}));

vi.mock("../pipelines", () => ({
  selectNoteStorage: () => "local",
  getNotePipeline: () => ({
    process: async (noteId: string) => {
      fakes.processed.push(noteId);
    },
    resumeAfterRestart: async (noteId: string) => {
      fakes.resumed.push(noteId);
    },
    deleteNote: async () => {},
  }),
}));

vi.mock("../repos", () => ({
  getNoteRepo: () => ({
    listNotes: async () => [...fakes.notes.values()].map((n) => ({ ...n })),
    upsertNote: async (note: Note) => {
      fakes.notes.set(note.id, structuredClone(note));
      return note;
    },
    deleteNote: async (noteId: string) => {
      fakes.notes.delete(noteId);
    },
    listSegments: async (noteId: string) =>
      [...fakes.segments.values()]
        .filter((segment) => segment.noteId === noteId)
        .map((segment) => ({ ...segment })),
    upsertSegment: async (segment: NoteSegment) => {
      fakes.segments.set(segment.id, structuredClone(segment));
      return segment;
    },
  }),
  getMeetingAudioRepo: () => ({
    startCapture: async ({
      noteId,
      segmentId,
    }: {
      noteId: string;
      segmentId: string;
    }) => {
      fakes.nativeCapture = {
        noteId,
        segmentId,
        audioPath: `/audio/${segmentId}.wav`,
        durationMs: 0,
        level: 0,
        interrupted: false,
      };
      return fakes.nativeCapture;
    },
    stopCapture: async () => {
      const capture = fakes.nativeCapture;
      fakes.nativeCapture = null;
      return capture ? { ...capture, durationMs: 42_000 } : null;
    },
    getCaptureStatus: async () => fakes.capture,
    repairSegment: async (path: string) => {
      fakes.repairedPaths.push(path);
      return 7_000;
    },
  }),
}));

const {
  handleMeetingCaptureProgress,
  initializeNotes,
  pauseMeetingNote,
  resumeMeetingNote,
  startMeetingNote,
  stopMeetingNote,
} = await import("./note.actions");

const NOW = "2026-05-01T12:00:00.000Z";

const storedNote = (id: string, status: Note["status"]): Note => ({
  id,
  storage: "local",
  status,
  title: id,
  titleSource: "default",
  error: null,
  source: "recording",
  personalNotes: "",
  generatedNotes: null,
  durationMs: 0,
  createdAt: NOW,
  updatedAt: NOW,
});

const storedSegment = (
  noteId: string,
  index: number,
  status: NoteSegment["status"],
  durationMs: number,
): NoteSegment => ({
  id: `${noteId}-${index}`,
  noteId,
  index,
  kind: "audio",
  status,
  durationMs,
  createdAt: NOW,
  transcript: null,
  transcribedMs: 0,
  audioPath: `/audio/${noteId}-${index}.wav`,
});

const flushWrites = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  fakes.notes.clear();
  fakes.segments.clear();
  fakes.capture = null;
  fakes.nativeCapture = null;
  fakes.repairedPaths = [];
  fakes.processed = [];
  fakes.resumed = [];
  setAppState(structuredClone(INITIAL_APP_STATE));
});

describe("initializeNotes", () => {
  it("re-enters every note's lifecycle after a crash", async () => {
    for (const status of [
      "recording",
      "paused",
      "pending",
      "processing",
      "ready",
      "failed",
    ] as const) {
      fakes.notes.set(status, storedNote(status, status));
    }
    fakes.segments.set(
      "recording-0",
      storedSegment("recording", 0, "recorded", 5_000),
    );
    fakes.segments.set(
      "recording-1",
      storedSegment("recording", 1, "recording", 0),
    );

    await initializeNotes();
    await flushWrites();

    const state = getAppState();
    expect(state.noteById.recording.status).toBe("paused");
    expect(state.noteById.recording.error?.code).toBe("capture_interrupted");
    expect(state.noteById.recording.durationMs).toBe(12_000);
    expect(fakes.repairedPaths).toEqual(["/audio/recording-1.wav"]);
    expect(fakes.segments.get("recording-1")).toMatchObject({
      status: "recorded",
      durationMs: 7_000,
    });
    expect(fakes.notes.get("recording")?.status).toBe("paused");

    expect(state.noteById.processing.status).toBe("pending");
    expect(state.noteById.paused.status).toBe("paused");
    expect(state.noteById.ready.status).toBe("ready");
    expect(state.noteById.failed.status).toBe("failed");
    expect(state.notes.activeNoteId).toBeNull();
    expect(fakes.resumed.sort()).toEqual(
      [
        "failed",
        "paused",
        "pending",
        "processing",
        "ready",
        "recording",
      ].sort(),
    );
  });

  it("keeps a recording the native layer is still capturing", async () => {
    fakes.notes.set("live", storedNote("live", "recording"));
    fakes.capture = {
      noteId: "live",
      segmentId: "live-0",
      audioPath: "/audio/live-0.wav",
      durationMs: 3_000,
      level: 0,
      interrupted: false,
    };
    fakes.segments.set("live-0", storedSegment("live", 0, "recording", 0));

    await initializeNotes();

    const state = getAppState();
    expect(state.noteById.live.status).toBe("recording");
    expect(state.notes.activeNoteId).toBe("live");
    expect(state.notes.capture?.segmentId).toBe("live-0");
    expect(fakes.repairedPaths).toEqual([]);
  });
});

describe("meeting capture actions", () => {
  it("records segments across pause and resume, then hands off on stop", async () => {
    const { noteId, alreadyActive } = await startMeetingNote();
    expect(alreadyActive).toBe(false);
    expect(getAppState().notes.activeNoteId).toBe(noteId);

    await pauseMeetingNote(noteId);
    expect(getAppState().noteById[noteId].status).toBe("paused");
    expect(getAppState().notes.capture).toBeNull();

    expect(await resumeMeetingNote(noteId)).toBeNull();
    expect(getAppState().noteById[noteId].status).toBe("recording");

    await stopMeetingNote(noteId);
    await flushWrites();

    const state = getAppState();
    expect(state.noteById[noteId].status).toBe("pending");
    expect(state.noteById[noteId].durationMs).toBe(84_000);
    expect(state.notes.activeNoteId).toBeNull();
    expect(state.noteSegmentsByNoteId[noteId].map((s) => s.status)).toEqual([
      "recorded",
      "recorded",
    ]);
    expect(fakes.processed).toEqual([noteId]);
    expect(fakes.notes.get(noteId)?.status).toBe("pending");
  });

  it("returns the meeting in progress instead of starting another", async () => {
    const first = await startMeetingNote();
    const second = await startMeetingNote();
    expect(second).toEqual({ noteId: first.noteId, alreadyActive: true });

    fakes.notes.set("other", storedNote("other", "paused"));
    setAppState((state) => ({
      ...state,
      noteById: { ...state.noteById, other: storedNote("other", "paused") },
    }));
    expect(await resumeMeetingNote("other")).toBe(first.noteId);
  });

  it("pauses with the audio kept when the microphone stops delivering", async () => {
    const { noteId } = await startMeetingNote();
    const capture = getAppState().notes.capture!;

    handleMeetingCaptureProgress({ ...capture, durationMs: 9_000 });
    expect(getAppState().notes.capture?.durationMs).toBe(9_000);

    handleMeetingCaptureProgress({ ...capture, interrupted: true });
    await vi.waitFor(() =>
      expect(getAppState().noteById[noteId].status).toBe("paused"),
    );
    expect(getAppState().noteById[noteId].error?.code).toBe(
      "capture_interrupted",
    );
    expect(getAppState().notes.activeNoteId).toBe(noteId);
  });

  it("recovers the segment duration when the native capture is gone", async () => {
    const { noteId } = await startMeetingNote();
    fakes.nativeCapture = null;

    await stopMeetingNote(noteId);

    expect(fakes.repairedPaths).toHaveLength(1);
    expect(getAppState().noteById[noteId].durationMs).toBe(7_000);
    expect(getAppState().noteById[noteId].status).toBe("pending");
  });

  it("ignores progress from a capture that already stopped", async () => {
    const { noteId } = await startMeetingNote();
    const capture = getAppState().notes.capture!;
    await pauseMeetingNote(noteId);

    handleMeetingCaptureProgress({ ...capture, interrupted: true });
    await flushWrites();
    expect(getAppState().notes.capture).toBeNull();
    expect(getAppState().noteById[noteId].error).toBeNull();
  });
});
