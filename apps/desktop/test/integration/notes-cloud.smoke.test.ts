/**
 * Drives CloudNoteRepo and CloudNotePipeline against a real /v1/notes server
 * running on the Firebase emulators with fake providers. Skipped unless
 * NOTES_SMOKE_CONFIG points at a JSON file with `{ base, users: { free,
 * pro: { idToken } } }` (see the core server's notes integration test for
 * how to start one).
 */
import type { Note, NoteSegment } from "@voquill/types";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { NoteAskEvent } from "../../src/pipelines/base-note.pipeline";
import { CloudNotePipeline } from "../../src/pipelines/cloud-note.pipeline";
import { FakeNoteStore } from "../../src/pipelines/fake-note-store.test-utils";
import { CloudNoteRepo, NotesApiError } from "../../src/repos/cloud-note.repo";

vi.mock("../../src/utils/log.utils", () => ({
  getLogger: () => ({
    info: () => {},
    warning: () => {},
    error: () => {},
    verbose: () => {},
  }),
}));

const configPath = process.env.NOTES_SMOKE_CONFIG;
const config = configPath
  ? (JSON.parse(readFileSync(configPath, "utf8")) as {
      base: string;
      users: Record<"free" | "pro", { uid: string; idToken: string }>;
    })
  : null;

const audioDir = mkdtempSync(join(tmpdir(), "notes-smoke-"));
const NOW = new Date().toISOString();

const harness = (plan: "free" | "pro") => {
  const user = config!.users[plan];
  const api = new CloudNoteRepo({
    baseUrl: config!.base,
    getAuth: async () => ({
      uid: user.uid,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${user.idToken}`,
      },
    }),
  }).forOwner(user.uid);
  const store = new FakeNoteStore();
  const pipeline = new CloudNotePipeline({
    store,
    repo: { searchNotes: async () => [], addDeletion: async () => {} },
    api: () => api,
    audio: {
      getFileSize: async (path) => statSync(path).size,
      uploadResumable: async ({ url, filePath, contentType }) => {
        const bytes = readFileSync(filePath);
        const response = await fetch(url, {
          method: "PUT",
          headers: {
            "Content-Type": contentType,
            "Content-Range": `bytes 0-${bytes.length - 1}/${bytes.length}`,
          },
          body: new Uint8Array(bytes),
        });
        const complete = response.status === 200 || response.status === 201;
        return {
          outcome: complete ? "complete" : "rejected",
          uploadedBytes: complete ? bytes.length : 0,
          totalBytes: bytes.length,
          status: response.status,
          message: null,
        };
      },
      cancelUpload: async () => {},
      deleteSegmentAudio: async (path) => {
        store.log.push(`delete-audio:${path}`);
      },
    },
    connectivity: { isOnline: () => true, waitUntilOnline: async () => {} },
    sleep: (ms) =>
      new Promise((resolve) => setTimeout(resolve, Math.min(ms, 300))),
    now: () => Date.now(),
    getCloudNotesUserId: () => user.uid,
    setActivity: () => {},
    onSettled: () => {},
    isNoteOpen: () => true,
    yieldToDictation: async () => {},
  });
  return { api, store, pipeline, user };
};

const recordingNote = (id: string, ownerUserId: string): Note => ({
  id,
  storage: "cloud",
  status: "pending",
  title: "Meeting, smoke test",
  titleSource: "default",
  error: null,
  source: "recording",
  personalNotes: "focus on the budget",
  generatedNotes: null,
  durationMs: 60_000,
  createdAt: NOW,
  updatedAt: NOW,
  processedWith: null,
  cloud: {
    ownerUserId,
    onServer: false,
    unsyncedFields: [],
    processRequestedAt: null,
    serverUpdatedAt: null,
    fetchedUpdatedAt: null,
  },
});

const segmentFile = (
  noteId: string,
  index: number,
  text: string,
): NoteSegment => {
  const id = crypto.randomUUID();
  const audioPath = join(audioDir, `${id}.wav`);
  writeFileSync(audioPath, text);
  return {
    id,
    noteId,
    index,
    kind: "audio",
    status: "recorded",
    error: null,
    durationMs: 30_000,
    createdAt: NOW,
    transcript: null,
    transcribedMs: 0,
    audioPath,
    upload: null,
  };
};

describe.skipIf(!config)("cloud notes against a local server", () => {
  it("records, uploads, processes, searches, asks, regenerates and deletes", async () => {
    const { api, store, pipeline, user } = harness("pro");
    const noteId = crypto.randomUUID();
    store.notes.set(noteId, recordingNote(noteId, user.uid));
    store.segments.set(noteId, [
      segmentFile(
        noteId,
        0,
        "We need to talk about the budget freeze and hiring today please team",
      ),
      segmentFile(
        noteId,
        1,
        "We need to talk about the budget freeze and travel today please team",
      ),
    ]);

    await pipeline.process(noteId);

    const note = store.getNote(noteId)!;
    expect(note.status).toBe("ready");
    expect(note.title).toBe("Budget freeze sync");
    expect(note.generatedNotes).toContain("budget freeze");
    expect(note.personalNotes).toBe("focus on the budget");
    const segments = store.getSegments(noteId);
    expect(segments.map((s) => s.status)).toEqual([
      "transcribed",
      "transcribed",
    ]);
    expect(segments.every((s) => s.audioPath === null)).toBe(true);
    expect(store.log.filter((e) => e.startsWith("delete-audio"))).toHaveLength(
      2,
    );

    const server = await api.getNote(noteId);
    expect(server.segments).toHaveLength(2);
    expect(server.personalNotes).toBe("focus on the budget");

    const results = await api.search("budget freeze");
    expect(results.map((r) => r.note.id)).toContain(noteId);

    const events: NoteAskEvent[] = [];
    for await (const event of api.ask({
      question: "What about the budget?",
      noteId,
      history: [],
    })) {
      events.push(event);
    }
    expect(events[0]).toMatchObject({ type: "sources" });
    expect(events.at(-1)).toMatchObject({ type: "done" });

    await store.updateNote(noteId, (draft) => {
      draft.title = "Renamed";
      draft.titleSource = "user";
      draft.cloud!.unsyncedFields = ["title"];
    });
    await pipeline.saveEdits(noteId);
    expect((await api.getNote(noteId)).title).toBe("Renamed");

    await pipeline.regenerate(noteId);
    await vi.waitFor(
      () => expect(store.getNote(noteId)?.status).toBe("ready"),
      {
        timeout: 30_000,
      },
    );
    await expect(pipeline.regenerate(noteId)).rejects.toMatchObject({
      code: "regenerate_cooldown",
    });
    expect(store.getNote(noteId)?.status).toBe("ready");

    await pipeline.deleteNote(noteId);
    await expect(api.getNote(noteId)).rejects.toBeInstanceOf(NotesApiError);
    await api.deleteNote(noteId);
  }, 120_000);

  it("drops an untranscribed segment with the segment delete route", async () => {
    const { api } = harness("pro");
    const noteId = crypto.randomUUID();
    const segmentId = crypto.randomUUID();
    await api.requestSegmentUpload(noteId, segmentId, {
      durationMs: 1_000,
      sizeBytes: 10,
      index: 0,
    });
    expect((await api.getNote(noteId)).segments).toHaveLength(1);
    await api.deleteSegment(noteId, segmentId);
    expect((await api.getNote(noteId)).segments).toHaveLength(0);
    await api.deleteNote(noteId);
  }, 60_000);

  it("queues a free user's second import behind the first until both are ready", async () => {
    const { store, pipeline } = harness("free");
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    await Promise.all(
      ids.map((id, i) =>
        pipeline.importTranscript({
          id,
          transcript: `Alice: we need to talk about the budget freeze, part ${i}.`,
          title: null,
          defaultTitle: "Imported transcript",
        }),
      ),
    );
    for (const id of ids) {
      expect(store.getNote(id)?.status).toBe("ready");
      expect(store.getSegments(id).map((s) => s.id)).toEqual([`${id}-import`]);
    }
  }, 120_000);
});
