import type { Note, NoteSegment } from "@voquill/types";
import { describe, expect, it, vi } from "vitest";
import {
  NotesApiError,
  NotesNetworkError,
  type ServerNote,
  type ServerNoteSegment,
  type ServerNoteWithSegments,
} from "../repos/cloud-note.repo";
import type { ResumableUploadOutcome } from "../repos/meeting-audio.repo";
import type { NoteCloudActivity } from "../state/notes.state";
import { recoverNoteStatus } from "../utils/note-state.utils";
import { CloudNotePipeline, type CloudNoteApi } from "./cloud-note.pipeline";
import { FakeNoteStore } from "./fake-note-store.test-utils";

vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    info: () => {},
    warning: () => {},
    error: () => {},
    verbose: () => {},
  }),
}));

const USER = "user-1";
const NOW = "2026-05-01T12:00:00.000Z";

type Failure = NotesApiError | NotesNetworkError;

/** An in-memory `/v1/notes` with the contract's idempotency rules. */
class FakeNotesServer implements CloudNoteApi {
  notes = new Map<string, ServerNoteWithSegments>();
  audio = new Map<string, number>();
  sessions = new Map<string, { noteId: string; segmentId: string }>();
  calls: string[] = [];
  failures = new Map<string, Failure[]>();
  failSegmentIds = new Set<string>();
  /** Polls that still report `processing` before the job finishes. */
  pollsUntilDone = 1;
  private sessionCounter = 0;
  private clock = 0;

  private stamp() {
    this.clock += 1;
    return new Date(Date.parse(NOW) + this.clock * 1000).toISOString();
  }

  private maybeFail(method: string) {
    this.calls.push(method);
    const queue = this.failures.get(method);
    const next = queue?.shift();
    if (next) throw next;
  }

  failNext(method: string, ...errors: Failure[]) {
    this.failures.set(method, [
      ...(this.failures.get(method) ?? []),
      ...errors,
    ]);
  }

  private require(noteId: string) {
    const note = this.notes.get(noteId);
    if (!note) throw new NotesApiError(404, "note_not_found", "missing");
    return note;
  }

  private ensure(noteId: string, createdAt = NOW): ServerNoteWithSegments {
    let note = this.notes.get(noteId);
    if (!note) {
      note = {
        id: noteId,
        title: "Untitled note",
        titleSource: "default",
        status: "draft",
        error: null,
        source: "recording",
        personalNotes: "",
        generatedNotes: null,
        durationMs: 0,
        createdAt,
        updatedAt: this.stamp(),
        segments: [],
      };
      this.notes.set(noteId, note);
    }
    return note;
  }

  private listed(note: ServerNoteWithSegments): ServerNote {
    const { segments: _segments, ...rest } = note;
    return structuredClone(rest);
  }

  async getNote(noteId: string) {
    this.maybeFail("getNote");
    const note = this.require(noteId);
    if (note.status === "processing" && --this.pollsUntilDone < 0) {
      this.finishJob(note);
    }
    return structuredClone(note);
  }

  private finishJob(note: ServerNoteWithSegments) {
    for (const segment of note.segments) {
      if (segment.status !== "uploaded") continue;
      if (this.failSegmentIds.has(segment.id)) {
        segment.status = "failed";
        segment.error = { code: "unsupported_audio", message: "bad" };
      } else {
        segment.status = "transcribed";
        segment.transcript = {
          text: `words of ${segment.id}`,
          utterances: [
            {
              startMs: 0,
              endMs: 1000,
              speaker: 0,
              text: `words of ${segment.id}`,
            },
          ],
        };
        this.audio.delete(segment.id);
      }
    }
    const transcribed = note.segments.some((s) => s.status === "transcribed");
    note.status = transcribed ? "ready" : "failed";
    note.error = transcribed
      ? null
      : { code: "unsupported_audio", message: "bad" };
    note.generatedNotes = transcribed ? "Server notes." : note.generatedNotes;
    if (transcribed && note.titleSource === "default") {
      note.title = "Server title";
      note.titleSource = "ai";
    }
    note.updatedAt = this.stamp();
  }

  async putNote(
    noteId: string,
    body: {
      title: string;
      titleSource: "default" | "user";
      personalNotes: string;
      createdAt: string;
    },
  ) {
    this.maybeFail("putNote");
    const note = this.ensure(noteId, body.createdAt);
    if (body.titleSource === "user" || note.titleSource === "default") {
      note.title = body.title;
      note.titleSource = body.titleSource;
    }
    note.personalNotes = body.personalNotes;
    note.updatedAt = this.stamp();
    return this.listed(note);
  }

  async patchNote(
    noteId: string,
    body: { title?: string; personalNotes?: string },
  ) {
    this.maybeFail("patchNote");
    const note = this.require(noteId);
    if (body.title !== undefined) {
      note.title = body.title;
      note.titleSource = "user";
    }
    if (body.personalNotes !== undefined)
      note.personalNotes = body.personalNotes;
    note.updatedAt = this.stamp();
    return this.listed(note);
  }

  async deleteNote(noteId: string) {
    this.maybeFail("deleteNote");
    this.notes.delete(noteId);
  }

  async requestSegmentUpload(
    noteId: string,
    segmentId: string,
    body: { durationMs: number; sizeBytes: number; index: number },
  ) {
    this.maybeFail("requestSegmentUpload");
    const note = this.ensure(noteId);
    let segment = note.segments.find((s) => s.id === segmentId);
    if (segment?.status === "transcribed") {
      throw new NotesApiError(409, "segment_transcribed", "done");
    }
    if (!segment) {
      segment = {
        id: segmentId,
        index: body.index,
        kind: "audio",
        status: "uploading",
        error: null,
        durationMs: body.durationMs,
        createdAt: NOW,
        transcript: null,
      } satisfies ServerNoteSegment;
      note.segments.push(segment);
      note.segments.sort((a, b) => a.index - b.index);
    }
    const url = `https://upload/${++this.sessionCounter}`;
    this.sessions.set(url, { noteId, segmentId });
    return url;
  }

  async deleteSegment(noteId: string, segmentId: string) {
    this.maybeFail("deleteSegment");
    const note = this.require(noteId);
    note.segments = note.segments.filter((s) => s.id !== segmentId);
  }

  async processNote(noteId: string, body: { personalNotes?: string }) {
    this.maybeFail("processNote");
    const note = this.require(noteId);
    const missing = note.segments
      .filter((s) => s.status !== "transcribed" && !this.audio.has(s.id))
      .map((s) => s.id);
    if (missing.length > 0) {
      throw new NotesApiError(409, "audio_missing", "missing", {
        segmentIds: missing,
      });
    }
    if (body.personalNotes !== undefined)
      note.personalNotes = body.personalNotes;
    let fresh = false;
    for (const segment of note.segments) {
      if (segment.status === "uploading" || segment.status === "failed") {
        segment.status = "uploaded";
        segment.error = null;
        fresh = true;
      }
    }
    if (note.status !== "processing" && (fresh || note.status !== "ready")) {
      note.status = "processing";
      note.updatedAt = this.stamp();
    }
    return this.listed(note);
  }

  async regenerateNote(noteId: string) {
    this.maybeFail("regenerateNote");
    const note = this.require(noteId);
    note.status = "processing";
    return this.listed(note);
  }

  async importNote(body: {
    id: string;
    transcript: string;
    title?: string;
    createdAt: string;
  }) {
    this.maybeFail("importNote");
    let note = this.notes.get(body.id);
    if (!note) {
      note = {
        ...this.ensure(body.id, body.createdAt),
        source: "import",
        status: "processing",
        title: body.title ?? "Imported transcript",
        titleSource: body.title ? "user" : "default",
        segments: [
          {
            id: "import",
            index: 0,
            kind: "import",
            status: "transcribed",
            error: null,
            durationMs: 0,
            createdAt: NOW,
            transcript: { text: body.transcript, utterances: [] },
          },
        ],
      };
      this.notes.set(body.id, note);
    }
    return this.listed(note);
  }

  async search() {
    this.maybeFail("search");
    return [...this.notes.values()].map((note) => ({
      note: this.listed(note),
      snippet: "server snippet",
      score: 1,
    }));
  }

  async *ask() {
    yield { type: "done" as const, answer: "", sources: [] };
  }

  /** The bytes of a completed upload session. */
  receive(url: string) {
    const session = this.sessions.get(url);
    if (!session) return false;
    this.audio.set(session.segmentId, 1);
    return true;
  }
}

const localNote = (overrides: Partial<Note> = {}): Note => ({
  id: "note",
  storage: "cloud",
  status: "pending",
  title: "Meeting, May 1",
  titleSource: "default",
  error: null,
  source: "recording",
  personalNotes: "my own notes",
  generatedNotes: null,
  durationMs: 2_000,
  createdAt: NOW,
  updatedAt: NOW,
  cloud: {
    ownerUserId: USER,
    onServer: false,
    unsyncedFields: [],
    processRequestedAt: null,
    serverUpdatedAt: null,
    fetchedUpdatedAt: null,
  },
  ...overrides,
});

const recordedSegment = (index: number): NoteSegment => ({
  id: `seg-${index}`,
  noteId: "note",
  index,
  kind: "audio",
  status: "recorded",
  error: null,
  durationMs: 1_000,
  createdAt: NOW,
  transcript: null,
  transcribedMs: 0,
  audioPath: `/audio/seg-${index}.wav`,
  upload: null,
});

type UploadScript = (url: string) => ResumableUploadOutcome["outcome"];

const createHarness = ({
  note = localNote(),
  segments = [recordedSegment(0), recordedSegment(1)],
  server = new FakeNotesServer(),
  store = new FakeNoteStore(),
  seed = true,
}: {
  note?: Note;
  segments?: NoteSegment[];
  server?: FakeNotesServer;
  store?: FakeNoteStore;
  seed?: boolean;
} = {}) => {
  if (seed) {
    store.notes.set(note.id, structuredClone(note));
    store.segments.set(note.id, structuredClone(segments));
  }
  let online = true;
  let waiters: (() => void)[] = [];
  let userId: string | null = USER;
  const uploads: { url: string; uploadId: string }[] = [];
  const cancelled: string[] = [];
  const activities: (NoteCloudActivity | null)[] = [];
  const deletions: string[] = [];
  let uploadScript: UploadScript = () => "complete";
  const yields = { count: 0, gate: Promise.resolve() };

  const pipeline = new CloudNotePipeline({
    store,
    repo: {
      searchNotes: async () => [],
      addDeletion: async (deletion) => {
        deletions.push(deletion.noteId);
      },
    },
    api: server,
    audio: {
      getFileSize: async () => 32_044,
      uploadResumable: async ({ url, uploadId }) => {
        uploads.push({ url, uploadId });
        const outcome = uploadScript(url);
        if (outcome === "complete") server.receive(url);
        return {
          outcome,
          uploadedBytes: 0,
          totalBytes: 32_044,
          status:
            outcome === "interrupted"
              ? 503
              : outcome === "rejected"
                ? 400
                : null,
          message: null,
        };
      },
      cancelUpload: async (uploadId) => {
        cancelled.push(uploadId);
      },
      deleteSegmentAudio: async (path) => {
        store.log.push(`delete-audio:${path}`);
      },
    },
    connectivity: {
      isOnline: () => online,
      waitUntilOnline: () =>
        online
          ? Promise.resolve()
          : new Promise<void>((resolve) => waiters.push(resolve)),
    },
    sleep: async () => {},
    now: () => Date.parse(NOW),
    getCloudNotesUserId: () => userId,
    setActivity: (_noteId, activity) => activities.push(activity),
    onSettled: () => {},
    yieldToDictation: async () => {
      yields.count++;
      await yields.gate;
    },
  });

  return {
    pipeline,
    server,
    store,
    uploads,
    cancelled,
    activities,
    deletions,
    yields,
    setOnline(value: boolean) {
      online = value;
      if (value) {
        const pending = waiters;
        waiters = [];
        pending.forEach((resolve) => resolve());
      }
    },
    setUser(value: string | null) {
      userId = value;
    },
    setUploads(script: UploadScript) {
      uploadScript = script;
    },
  };
};

/** What a restart does: reload from the same store, recover, run again. */
const restart = (harness: ReturnType<typeof createHarness>) => {
  for (const note of harness.store.notes.values()) {
    note.status = recoverNoteStatus(note.status, false);
  }
  return createHarness({
    server: harness.server,
    store: harness.store,
    seed: false,
  });
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("CloudNotePipeline.process", () => {
  it("creates, uploads, processes, stores the result, then releases audio", async () => {
    const harness = createHarness();
    await harness.pipeline.process("note");

    const note = harness.store.getNote("note")!;
    expect(note.status).toBe("ready");
    expect(note.title).toBe("Server title");
    expect(note.generatedNotes).toBe("Server notes.");
    expect(note.personalNotes).toBe("my own notes");
    expect(note.cloud?.onServer).toBe(true);
    expect(harness.server.calls.slice(0, 4)).toEqual([
      "putNote",
      "requestSegmentUpload",
      "requestSegmentUpload",
      "processNote",
    ]);
    expect(harness.server.notes.get("note")?.personalNotes).toBe(
      "my own notes",
    );

    const segments = harness.store.getSegments("note");
    expect(segments.map((s) => [s.status, s.audioPath])).toEqual([
      ["transcribed", null],
      ["transcribed", null],
    ]);
    expect(segments[0].transcript?.text).toBe("words of seg-0");

    const log = harness.store.log;
    const stored = log.indexOf("segment:seg-1:transcribed:1000");
    const ready = log.indexOf("note:ready");
    const firstDelete = log.findIndex((entry) =>
      entry.startsWith("delete-audio"),
    );
    expect(stored).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(-1);
    expect(firstDelete).toBeGreaterThan(Math.max(stored, ready));
  });

  it("keeps all audio while the server is still processing", async () => {
    const harness = createHarness();
    harness.server.pollsUntilDone = 2;
    harness.server.failNext(
      "getNote",
      new NotesApiError(500, "internal_error", "x"),
      new NotesApiError(500, "internal_error", "x"),
      new NotesApiError(500, "internal_error", "x"),
      new NotesApiError(500, "internal_error", "x"),
      new NotesApiError(500, "internal_error", "x"),
      new NotesApiError(500, "internal_error", "x"),
      new NotesApiError(500, "internal_error", "x"),
    );
    await harness.pipeline.process("note");

    expect(harness.store.getNote("note")?.status).toBe("failed");
    expect(harness.store.getNote("note")?.error?.code).toBe("internal_error");
    expect(
      harness.store.log.some((entry) => entry.startsWith("delete-audio")),
    ).toBe(false);
    expect(harness.store.getSegments("note").every((s) => s.audioPath)).toBe(
      true,
    );
  });

  it.each([
    ["putNote"],
    ["requestSegmentUpload"],
    ["processNote"],
    ["getNote"],
  ])(
    "retries a transient failure of %s without duplicating anything",
    async (method) => {
      const harness = createHarness();
      harness.server.failNext(
        method,
        new NotesNetworkError("offline"),
        new NotesApiError(503, "queue_unavailable", "busy"),
      );
      await harness.pipeline.process("note");

      expect(harness.store.getNote("note")?.status).toBe("ready");
      expect(harness.server.notes.size).toBe(1);
      expect(harness.server.notes.get("note")?.segments).toHaveLength(2);
    },
  );

  it("resumes an interrupted upload on the same session after a restart", async () => {
    const harness = createHarness();
    let killed = false;
    harness.setUploads(() => {
      if (!killed) {
        killed = true;
        harness.setUser(null);
        return "interrupted";
      }
      return "complete";
    });
    await harness.pipeline.process("note");

    expect(harness.store.getNote("note")?.status).toBe("pending");
    const firstUrl = harness.store.getSegments("note")[0].upload?.url;
    expect(firstUrl).toBeTruthy();

    const relaunched = restart(harness);
    await relaunched.pipeline.process("note");

    expect(relaunched.store.getNote("note")?.status).toBe("ready");
    expect(relaunched.uploads[0].url).toBe(firstUrl);
    expect(
      harness.server.calls.filter((c) => c === "requestSegmentUpload"),
    ).toHaveLength(2);
    expect(harness.server.notes.get("note")?.segments).toHaveLength(2);
  });

  it("calls process again for a note that was processing when the app quit", async () => {
    const harness = createHarness();
    harness.server.pollsUntilDone = 100;
    const poll = harness.server.getNote.bind(harness.server);
    harness.server.getNote = async (noteId) => {
      harness.setUser(null);
      return poll(noteId);
    };
    await harness.pipeline.process("note");
    harness.server.getNote = poll;
    expect(harness.store.getNote("note")?.status).toBe("processing");

    harness.server.pollsUntilDone = 0;
    const relaunched = restart(harness);
    await relaunched.pipeline.resumeAfterRestart("note");

    expect(relaunched.store.getNote("note")?.status).toBe("ready");
    expect(harness.server.calls.filter((c) => c === "processNote").length).toBe(
      2,
    );
    expect(
      harness.server.calls.filter((c) => c === "requestSegmentUpload"),
    ).toHaveLength(2);
  });

  it("waits for a connection when offline at stop, then continues", async () => {
    const harness = createHarness();
    harness.setOnline(false);
    const run = harness.pipeline.process("note");
    await flush();

    expect(harness.store.getNote("note")?.status).toBe("pending");
    expect(harness.activities).toContainEqual({
      kind: "waiting-for-connection",
    });
    expect(harness.server.calls).toEqual([]);

    harness.setOnline(true);
    await run;
    expect(harness.store.getNote("note")?.status).toBe("ready");
  });

  it("gets a new session when one expires and re-uploads what the server lost", async () => {
    const harness = createHarness();
    let first = true;
    harness.setUploads(() => {
      if (first) {
        first = false;
        return "expired";
      }
      return "complete";
    });
    harness.server.failNext(
      "processNote",
      new NotesApiError(409, "audio_missing", "missing", {
        segmentIds: ["seg-1"],
      }),
    );
    await harness.pipeline.process("note");

    expect(harness.store.getNote("note")?.status).toBe("ready");
    expect(harness.uploads.map((u) => u.uploadId)).toEqual([
      "seg-0",
      "seg-0",
      "seg-1",
      "seg-1",
    ]);
  });

  it("stops on a quota error without retrying and keeps the audio", async () => {
    const harness = createHarness();
    harness.server.failNext(
      "processNote",
      new NotesApiError(403, "word_quota_exceeded", "no words"),
    );
    await harness.pipeline.process("note");

    const note = harness.store.getNote("note")!;
    expect(note.status).toBe("failed");
    expect(note.error?.code).toBe("word_quota_exceeded");
    expect(
      harness.server.calls.filter((c) => c === "processNote"),
    ).toHaveLength(1);
    expect(harness.store.getSegments("note").every((s) => s.audioPath)).toBe(
      true,
    );

    await harness.pipeline.process("note");
    expect(
      harness.server.calls.filter((c) => c === "processNote"),
    ).toHaveLength(1);
  });

  it("keeps a failed segment's audio in a ready note, then retries or drops it", async () => {
    const harness = createHarness();
    harness.server.failSegmentIds.add("seg-1");
    await harness.pipeline.process("note");

    expect(harness.store.getNote("note")?.status).toBe("ready");
    const [done, failed] = harness.store.getSegments("note");
    expect(done.audioPath).toBeNull();
    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("unsupported_audio");
    expect(failed.audioPath).toBe("/audio/seg-1.wav");

    harness.server.failSegmentIds.clear();
    await harness.pipeline.retrySegment("note", "seg-1");
    expect(harness.store.getNote("note")?.status).toBe("ready");
    expect(harness.store.getSegments("note")[1]).toMatchObject({
      status: "transcribed",
      audioPath: null,
    });

    const second = createHarness();
    second.server.failSegmentIds.add("seg-1");
    await second.pipeline.process("note");
    await second.pipeline.dropSegment("note", "seg-1");
    expect(second.store.getSegments("note").map((s) => s.id)).toEqual([
      "seg-0",
    ]);
    expect(second.server.notes.get("note")?.segments.map((s) => s.id)).toEqual([
      "seg-0",
    ]);
    expect(second.store.log).toContain("delete-audio:/audio/seg-1.wav");
  });

  it("stops quietly when the account signs out and resumes for it later", async () => {
    const harness = createHarness();
    harness.setUser("someone-else");
    await harness.pipeline.process("note");
    expect(harness.server.calls).toEqual([]);
    expect(harness.store.getNote("note")?.status).toBe("pending");
  });
});

describe("CloudNotePipeline edits, import, regenerate and delete", () => {
  it("sends an edit made offline once back online", async () => {
    const harness = createHarness({
      note: localNote({
        status: "ready",
        cloud: {
          ...localNote().cloud!,
          onServer: true,
          unsyncedFields: ["personalNotes"],
        },
      }),
    });
    await harness.server.putNote("note", {
      title: "t",
      titleSource: "default",
      personalNotes: "old",
      createdAt: NOW,
    });
    harness.setOnline(false);
    const save = harness.pipeline.saveEdits("note");
    await flush();
    expect(harness.server.calls).not.toContain("patchNote");

    await harness.store.updateNote("note", (note) => {
      note.personalNotes = "latest";
    });
    harness.setOnline(true);
    await save;

    expect(harness.server.notes.get("note")?.personalNotes).toBe("latest");
    expect(harness.store.getNote("note")?.cloud?.unsyncedFields).toEqual([]);
  });

  it("keeps an edit unsynced when it changed while being sent", async () => {
    const harness = createHarness({
      note: localNote({
        status: "ready",
        cloud: {
          ...localNote().cloud!,
          onServer: true,
          unsyncedFields: ["title"],
        },
      }),
    });
    await harness.server.putNote("note", {
      title: "t",
      titleSource: "default",
      personalNotes: "",
      createdAt: NOW,
    });
    const original = harness.server.patchNote.bind(harness.server);
    harness.server.patchNote = async (noteId, body) => {
      await harness.store.updateNote(noteId, (note) => {
        note.title = "Typed later";
      });
      return original(noteId, body);
    };
    await harness.pipeline.saveEdits("note");
    expect(harness.store.getNote("note")?.cloud?.unsyncedFields).toEqual([
      "title",
    ]);
  });

  it("imports several transcripts at once, each exactly once", async () => {
    const harness = createHarness({ segments: [] });
    harness.server.pollsUntilDone = 0;
    await Promise.all([
      harness.pipeline.importTranscript({
        id: "a",
        transcript: "one",
        title: null,
        defaultTitle: "Imported",
      }),
      harness.pipeline.importTranscript({
        id: "b",
        transcript: "two",
        title: "Call",
        defaultTitle: "Imported",
      }),
    ]);
    expect(harness.server.calls.filter((c) => c === "importNote")).toHaveLength(
      2,
    );
    for (const id of ["a", "b"]) {
      const note = harness.store.getNote(id)!;
      expect(note.source).toBe("import");
      expect(harness.store.getSegments(id).map((s) => s.id)).toEqual([
        `${id}-import`,
      ]);
    }
    expect(harness.store.getNote("b")?.title).toBe("Call");
  });

  it("leaves a ready note as it was when regenerate is refused", async () => {
    const harness = createHarness({ note: localNote({ status: "ready" }) });
    await harness.server.putNote("note", {
      title: "t",
      titleSource: "default",
      personalNotes: "",
      createdAt: NOW,
    });
    harness.server.failNext(
      "regenerateNote",
      new NotesApiError(429, "regenerate_cooldown", "wait"),
    );
    await expect(harness.pipeline.regenerate("note")).rejects.toMatchObject({
      code: "regenerate_cooldown",
    });
    expect(harness.store.getNote("note")?.status).toBe("ready");
    expect(
      harness.server.calls.filter((c) => c === "regenerateNote"),
    ).toHaveLength(1);
  });

  it("deletes on the server, and remembers the delete when offline", async () => {
    const harness = createHarness();
    await harness.pipeline.process("note");
    await harness.pipeline.deleteNote("note");
    expect(harness.server.notes.has("note")).toBe(false);
    expect(harness.store.getNote("note")).toBeNull();

    const offline = createHarness();
    offline.server.failNext("deleteNote", new NotesNetworkError("offline"));
    await offline.pipeline.deleteNote("note");
    expect(offline.deletions).toEqual(["note"]);
    expect(offline.store.getNote("note")).toBeNull();
    expect(offline.cancelled).toEqual(["seg-0", "seg-1"]);
  });
});

describe("CloudNotePipeline.search", () => {
  it("merges server results with local ones and degrades offline", async () => {
    const harness = createHarness({
      note: localNote({ status: "ready" }),
    });
    await harness.server.putNote("other", {
      title: "From mobile",
      titleSource: "user",
      personalNotes: "",
      createdAt: NOW,
    });
    const results = await harness.pipeline.search("budget");
    expect(results.map((r) => [r.note.id, r.snippet])).toEqual([
      ["other", "server snippet"],
    ]);
    expect(harness.store.getNote("other")?.storage).toBe("cloud");

    harness.setOnline(false);
    expect(await harness.pipeline.search("budget")).toEqual([]);
    expect(harness.server.calls.filter((c) => c === "search")).toHaveLength(1);
  });
});

describe("CloudNotePipeline limits and priorities", () => {
  it("queues behind the plan's processing limit: two imports both finish", async () => {
    const harness = createHarness({ segments: [] });
    harness.server.pollsUntilDone = 0;
    harness.server.failNext(
      "importNote",
      new NotesApiError(429, "too_many_processing", "one at a time"),
      new NotesApiError(429, "too_many_processing", "one at a time"),
    );
    await Promise.all([
      harness.pipeline.importTranscript({
        id: "a",
        transcript: "one",
        title: null,
        defaultTitle: "Imported",
      }),
      harness.pipeline.importTranscript({
        id: "b",
        transcript: "two",
        title: null,
        defaultTitle: "Imported",
      }),
    ]);
    expect(harness.store.getNote("a")?.status).toBe("ready");
    expect(harness.store.getNote("b")?.status).toBe("ready");
    expect(harness.activities).toContainEqual({ kind: "server-busy" });
  });

  it("uploads in passes and yields to dictation before each one", async () => {
    const harness = createHarness();
    let passes = 0;
    harness.setUploads(() => (++passes % 3 === 0 ? "complete" : "partial"));
    await harness.pipeline.process("note");
    expect(harness.store.getNote("note")?.status).toBe("ready");
    expect(harness.uploads).toHaveLength(6);
    expect(harness.yields.count).toBe(6);
  });

  it("does not start an upload while a dictation is running", async () => {
    const harness = createHarness();
    let release: () => void = () => {};
    harness.yields.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = harness.pipeline.process("note");
    await flush();
    expect(harness.uploads).toEqual([]);
    release();
    await run;
    expect(harness.store.getNote("note")?.status).toBe("ready");
  });

  it("starts over with a fresh session when storage refuses the byte count", async () => {
    const harness = createHarness({ segments: [recordedSegment(0)] });
    let first = true;
    harness.setUploads(() => {
      if (first) {
        first = false;
        return "rejected";
      }
      return "complete";
    });
    await harness.pipeline.process("note");
    expect(harness.store.getNote("note")?.status).toBe("ready");
    expect(new Set(harness.uploads.map((u) => u.url)).size).toBe(2);
  });

  it("treats a segment already accepted by a running job as uploaded", async () => {
    const harness = createHarness({ segments: [recordedSegment(0)] });
    harness.server.failNext(
      "requestSegmentUpload",
      new NotesApiError(409, "segment_processing", "busy"),
    );
    harness.server.notes.set("note", {
      ...(await harness.server.putNote("note", {
        title: "t",
        titleSource: "default",
        personalNotes: "",
        createdAt: NOW,
      })),
      segments: [
        {
          id: "seg-0",
          index: 0,
          kind: "audio",
          status: "uploaded",
          error: null,
          durationMs: 1000,
          createdAt: NOW,
          transcript: null,
        },
      ],
    });
    harness.server.audio.set("seg-0", 1);
    await harness.pipeline.process("note");
    expect(harness.store.getNote("note")?.error).toBeNull();
    expect(harness.uploads).toEqual([]);
    expect(harness.store.getNote("note")?.status).toBe("ready");
  });
});
