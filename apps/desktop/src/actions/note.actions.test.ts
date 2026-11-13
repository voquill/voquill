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
  rolls: [] as string[],
  orphans: [] as {
    noteId: string;
    segmentId: string;
    audioPath: string;
    durationMs: number;
    noteExists: boolean;
  }[],
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
      append,
    }: {
      noteId: string;
      segmentId: string;
      append: boolean;
    }) => {
      const existing = append
        ? (fakes.segments.get(segmentId)?.durationMs ?? 0)
        : 0;
      fakes.nativeCapture = {
        noteId,
        segmentId,
        audioPath: `/audio/${segmentId}.wav`,
        durationMs: existing,
        initialDurationMs: existing,
        level: 0,
        interruption: null,
      };
      return fakes.nativeCapture;
    },
    stopCapture: async () => {
      const capture = fakes.nativeCapture;
      fakes.nativeCapture = null;
      return capture
        ? { ...capture, durationMs: capture.durationMs + 42_000 }
        : null;
    },
    rollCapture: async (noteId: string, segmentId: string) => {
      const current = fakes.nativeCapture!;
      fakes.rolls.push(segmentId);
      fakes.nativeCapture = {
        ...current,
        segmentId,
        audioPath: `/audio/${segmentId}.wav`,
        durationMs: 0,
        initialDurationMs: 0,
      };
      return {
        finished: { ...current, noteId, durationMs: current.durationMs },
        status: fakes.nativeCapture,
      };
    },
    listUnreferencedAudio: async () => fakes.orphans,
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

const { NOTE_RECORDING_LIMIT_MS, NOTE_SEGMENT_ROLL_MS } =
  await import("../utils/note-audio.utils");

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
  processedWith: null,
  cloud: null,
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
  error: null,
  upload: null,
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
  fakes.rolls = [];
  fakes.orphans = [];
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
      initialDurationMs: 0,
      level: 0,
      interruption: null,
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
    // Resuming continues the same segment, so pauses never add segments.
    expect(state.noteSegmentsByNoteId[noteId].map((s) => s.status)).toEqual([
      "recorded",
    ]);
    expect(fakes.processed).toEqual([noteId]);
    expect(fakes.notes.get(noteId)?.status).toBe("pending");
  });

  it("returns the meeting in progress instead of starting another", async () => {
    const first = await startMeetingNote();
    const second = await startMeetingNote();
    expect(second).toEqual({
      noteId: first.noteId,
      alreadyActive: true,
      finishedNoteIds: [],
    });

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

    handleMeetingCaptureProgress({ ...capture, interruption: "no-audio" });
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

    handleMeetingCaptureProgress({ ...capture, interruption: "no-audio" });
    await flushWrites();
    expect(getAppState().notes.capture).toBeNull();
    expect(getAppState().noteById[noteId].error).toBeNull();
  });
});

describe("recording limits", () => {
  it("rolls to a new segment before the file grows past the smallest segment cap", async () => {
    const { noteId } = await startMeetingNote();
    const capture = getAppState().notes.capture!;
    fakes.nativeCapture = {
      ...fakes.nativeCapture!,
      durationMs: NOTE_SEGMENT_ROLL_MS,
    };

    handleMeetingCaptureProgress({
      ...capture,
      durationMs: NOTE_SEGMENT_ROLL_MS,
    });
    await vi.waitFor(() => expect(fakes.rolls).toHaveLength(1));
    await vi.waitFor(() =>
      expect(getAppState().noteSegmentsByNoteId[noteId]).toHaveLength(2),
    );

    const [first, second] = getAppState().noteSegmentsByNoteId[noteId];
    expect(first).toMatchObject({
      status: "recorded",
      durationMs: NOTE_SEGMENT_ROLL_MS,
    });
    expect(second).toMatchObject({ status: "recording", index: 1 });
    expect(getAppState().notes.capture?.segmentId).toBe(second.id);
    expect(getAppState().noteById[noteId].durationMs).toBe(
      NOTE_SEGMENT_ROLL_MS,
    );
  });

  it("stops at the note limit with the audio kept, and refuses to resume", async () => {
    const { noteId } = await startMeetingNote();
    const capture = getAppState().notes.capture!;
    fakes.nativeCapture = {
      ...fakes.nativeCapture!,
      durationMs: NOTE_RECORDING_LIMIT_MS,
    };

    handleMeetingCaptureProgress({
      ...capture,
      durationMs: NOTE_RECORDING_LIMIT_MS,
    });
    await vi.waitFor(() =>
      expect(getAppState().noteById[noteId].status).toBe("paused"),
    );
    expect(getAppState().noteById[noteId].error?.code).toBe(
      "note_length_limit",
    );
    expect(getAppState().noteSegmentsByNoteId[noteId][0].status).toBe(
      "recorded",
    );

    await expect(resumeMeetingNote(noteId)).rejects.toMatchObject({
      code: "note_length_limit",
    });
  });

  it("pauses at once when the disk refuses writes", async () => {
    const { noteId } = await startMeetingNote();
    const capture = getAppState().notes.capture!;
    handleMeetingCaptureProgress({ ...capture, interruption: "write-failed" });
    await vi.waitFor(() =>
      expect(getAppState().noteById[noteId].error?.code).toBe(
        "capture_write_failed",
      ),
    );
    expect(getAppState().noteById[noteId].status).toBe("paused");
  });
});

describe("unreferenced meeting audio", () => {
  it("adopts files no segment references instead of dropping them", async () => {
    fakes.notes.set("paused", storedNote("paused", "paused"));
    fakes.orphans = [
      {
        noteId: "paused",
        segmentId: "lost-1",
        audioPath: "/audio/lost-1.wav",
        durationMs: 5_000,
        noteExists: true,
      },
      {
        noteId: "gone",
        segmentId: "lost-2",
        audioPath: "/audio/lost-2.wav",
        durationMs: 9_000,
        noteExists: false,
      },
      {
        noteId: "other-account",
        segmentId: "lost-3",
        audioPath: "/audio/lost-3.wav",
        durationMs: 9_000,
        noteExists: true,
      },
      {
        noteId: "empty",
        segmentId: "lost-4",
        audioPath: "/audio/lost-4.wav",
        durationMs: 0,
        noteExists: false,
      },
    ];

    await initializeNotes();
    await flushWrites();

    const state = getAppState();
    expect(state.noteSegmentsByNoteId.paused.map((s) => s.id)).toEqual([
      "lost-1",
    ]);
    expect(state.noteById.paused.durationMs).toBe(5_000);
    expect(state.noteById.gone).toMatchObject({
      status: "paused",
      durationMs: 9_000,
    });
    expect(state.noteSegmentsByNoteId.gone[0]).toMatchObject({
      id: "lost-2",
      status: "recorded",
      audioPath: "/audio/lost-2.wav",
    });
    expect(state.noteById["other-account"]).toBeUndefined();
    expect(state.noteById.empty).toBeUndefined();
  });
});

describe("recovered recordings and accounts", () => {
  it("finishes an interrupted meeting when a new one starts, instead of blocking it", async () => {
    const first = await startMeetingNote();
    const capture = getAppState().notes.capture!;
    handleMeetingCaptureProgress({ ...capture, interruption: "no-audio" });
    await vi.waitFor(() =>
      expect(getAppState().noteById[first.noteId].status).toBe("paused"),
    );

    const second = await startMeetingNote();

    expect(second.alreadyActive).toBe(false);
    expect(second.noteId).not.toBe(first.noteId);
    expect(second.finishedNoteIds).toEqual([first.noteId]);
    expect(getAppState().noteById[first.noteId].status).toBe("pending");
    expect(fakes.processed).toContain(first.noteId);
    expect(getAppState().notes.activeNoteId).toBe(second.noteId);
  });

  it("keeps one meeting at a time for a meeting the user paused", async () => {
    const first = await startMeetingNote();
    await pauseMeetingNote(first.noteId);
    const second = await startMeetingNote();
    expect(second).toMatchObject({
      noteId: first.noteId,
      alreadyActive: true,
      finishedNoteIds: [],
    });
  });

  it("stops a cloud meeting safely when its account signs out (S4)", async () => {
    setAppState((state) => ({
      ...state,
      auth: { uid: "u1", email: null, displayName: null, providers: [] },
      notes: { ...state.notes, loaded: true, loadedForUserId: "u1" },
    }));
    const { noteId } = await startMeetingNote();
    setAppState((state) => ({
      ...state,
      noteById: {
        ...state.noteById,
        [noteId]: {
          ...state.noteById[noteId],
          storage: "cloud",
          cloud: {
            ownerUserId: "u1",
            onServer: false,
            unsyncedFields: [],
            processRequestedAt: null,
            serverUpdatedAt: null,
            fetchedUpdatedAt: null,
          },
        },
      },
    }));
    expect(fakes.nativeCapture).not.toBeNull();

    setAppState((state) => ({ ...state, auth: null }));
    await initializeNotes();
    await flushWrites();

    expect(fakes.nativeCapture).toBeNull();
    expect(fakes.notes.get(noteId)).toMatchObject({ status: "pending" });
    expect(
      [...fakes.segments.values()].find((s) => s.noteId === noteId),
    ).toMatchObject({ status: "recorded", durationMs: 42_000 });
    expect(getAppState().notes.activeNoteId).toBeNull();
    expect(getAppState().notes.capture).toBeNull();
  });

  it("keeps recording a local meeting when the account signs out", async () => {
    setAppState((state) => ({
      ...state,
      auth: { uid: "u1", email: null, displayName: null, providers: [] },
      notes: { ...state.notes, loaded: true, loadedForUserId: "u1" },
    }));
    const { noteId } = await startMeetingNote();
    fakes.notes.set(noteId, getAppState().noteById[noteId]);
    fakes.capture = fakes.nativeCapture;
    setAppState((state) => ({ ...state, auth: null }));
    await initializeNotes();
    expect(fakes.nativeCapture?.noteId).toBe(noteId);
    expect(getAppState().noteById[noteId].status).toBe("recording");
  });

  it("attaches found audio to a finished note, flagged, and adopts unknown audio as a local note (S9, N7)", async () => {
    fakes.notes.set("done", storedNote("done", "ready"));
    fakes.orphans = [
      {
        noteId: "done",
        segmentId: "late",
        audioPath: "/audio/late.wav",
        durationMs: 4_000,
        noteExists: true,
      },
      {
        noteId: "unknown",
        segmentId: "lost",
        audioPath: "/audio/lost.wav",
        durationMs: 4_000,
        noteExists: false,
      },
    ];
    setAppState((state) => ({
      ...state,
      auth: { uid: "u1", email: null, displayName: null, providers: [] },
    }));

    await initializeNotes();
    await flushWrites();

    const state = getAppState();
    expect(state.noteById.done).toMatchObject({
      status: "ready",
      error: { code: "recovered_audio" },
    });
    expect(state.noteSegmentsByNoteId.done.map((s) => s.id)).toEqual(["late"]);
    expect(state.noteById.unknown).toMatchObject({
      storage: "local",
      cloud: null,
      status: "paused",
    });
  });
});
