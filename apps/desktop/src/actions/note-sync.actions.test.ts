import type { Note, NoteSegment } from "@voquill/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerNote } from "../repos/cloud-note.repo";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";

const fakes = vi.hoisted(() => ({
  serverNotes: [] as ServerNote[],
  segments: new Map<string, NoteSegment[]>(),
  deletions: [] as { noteId: string; ownerUserId: string; createdAt: number }[],
  serverDeletes: [] as string[],
  localDeletes: [] as string[],
  serverDeleteFails: false,
  onList: () => {},
}));

vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    info: () => {},
    warning: () => {},
    error: () => {},
    verbose: () => {},
  }),
}));

vi.mock("../repos", () => ({
  getCloudNoteRepo: () => ({
    listAllNotes: async () => {
      fakes.onList();
      return fakes.serverNotes;
    },
    deleteNote: async (noteId: string) => {
      if (fakes.serverDeleteFails) throw new Error("offline");
      fakes.serverDeletes.push(noteId);
    },
  }),
  getNoteRepo: () => ({
    listDeletions: async () => fakes.deletions,
    removeDeletion: async (noteId: string) => {
      fakes.deletions = fakes.deletions.filter((d) => d.noteId !== noteId);
    },
    listSegments: async (noteId: string) => fakes.segments.get(noteId) ?? [],
    upsertNote: async (note: Note) => note,
    upsertSegment: async (segment: NoteSegment) => segment,
    deleteNote: async (noteId: string) => {
      fakes.localDeletes.push(noteId);
    },
  }),
}));

const { syncCloudNotes } = await import("./note-sync.actions");
const { noteStore } = await import("./note-store.actions");

const NOW = "2026-05-01T12:00:00.000Z";

const serverNote = (id: string): ServerNote => ({
  id,
  title: `Server ${id}`,
  titleSource: "ai",
  status: "ready",
  error: null,
  source: "recording",
  personalNotes: "",
  generatedNotes: "Notes.",
  durationMs: 1_000,
  createdAt: NOW,
  updatedAt: NOW,
});

const cloudNote = (id: string, owner = "u1"): Note => ({
  id,
  storage: "cloud",
  status: "ready",
  title: id,
  titleSource: "ai",
  error: null,
  source: "recording",
  personalNotes: "",
  generatedNotes: null,
  durationMs: 0,
  createdAt: NOW,
  updatedAt: NOW,
  cloud: {
    ownerUserId: owner,
    onServer: true,
    unsyncedFields: [],
    processRequestedAt: null,
    serverUpdatedAt: null,
    fetchedUpdatedAt: null,
  },
});

const withAudio = (noteId: string): NoteSegment[] => [
  {
    id: `${noteId}-s`,
    noteId,
    index: 0,
    kind: "audio",
    status: "failed",
    error: null,
    durationMs: 1_000,
    createdAt: NOW,
    transcript: null,
    transcribedMs: 0,
    audioPath: `/audio/${noteId}.wav`,
    upload: null,
  },
];

const signIn = (uid: string, loadedForUserId: string | null = uid) => {
  setAppState((state) => ({
    ...state,
    auth: { uid, email: null, displayName: null, providers: [] },
    notes: { ...state.notes, loaded: true, loadedForUserId },
  }));
};

beforeEach(() => {
  fakes.serverNotes = [];
  fakes.segments.clear();
  fakes.deletions = [];
  fakes.serverDeletes = [];
  fakes.localDeletes = [];
  fakes.serverDeleteFails = false;
  fakes.onList = () => {};
  const notes = [
    cloudNote("kept"),
    cloudNote("gone-clean"),
    cloudNote("gone-audio"),
    { ...cloudNote("local"), storage: "local" as const, cloud: null },
  ];
  setAppState({
    ...structuredClone(INITIAL_APP_STATE),
    noteById: Object.fromEntries(notes.map((note) => [note.id, note])),
  });
  fakes.segments.set("gone-audio", withAudio("gone-audio"));
});

describe("syncCloudNotes", () => {
  it("adds notes from other devices and removes only clean copies the server dropped", async () => {
    signIn("u1");
    fakes.serverNotes = [serverNote("kept"), serverNote("mobile")];
    fakes.deletions = [
      { noteId: "deleted-offline", ownerUserId: "u1", createdAt: 1 },
    ];

    await syncCloudNotes({ force: true });

    const ids = Object.keys(getAppState().noteById).sort();
    expect(ids).toEqual(["gone-audio", "kept", "local", "mobile"]);
    expect(getAppState().noteById.mobile).toMatchObject({
      storage: "cloud",
      title: "Server mobile",
      cloud: { ownerUserId: "u1" },
    });
    expect(getAppState().noteById.kept.generatedNotes).toBe("Notes.");
    expect(fakes.localDeletes).toEqual(["gone-clean"]);
    expect(fakes.serverDeletes).toEqual(["deleted-offline"]);
    expect(fakes.deletions).toEqual([]);
  });

  it("does not bring back a note deleted here while the delete is still owed", async () => {
    signIn("u1");
    fakes.serverNotes = [serverNote("kept"), serverNote("deleted-offline")];
    fakes.deletions = [
      { noteId: "deleted-offline", ownerUserId: "u1", createdAt: 1 },
    ];
    fakes.serverDeleteFails = true;

    await syncCloudNotes({ force: true });

    expect(getAppState().noteById["deleted-offline"]).toBeUndefined();
    expect(fakes.deletions).toHaveLength(1);
  });

  it("does nothing until the signed-in account's notes are loaded", async () => {
    signIn("u2", "u1");
    fakes.serverNotes = [serverNote("u2-note")];
    await syncCloudNotes({ force: true });
    expect(getAppState().noteById["u2-note"]).toBeUndefined();
    expect(fakes.localDeletes).toEqual([]);
  });

  it("drops the result when the account changes during a sync", async () => {
    signIn("u1");
    fakes.serverNotes = [serverNote("mobile")];
    fakes.onList = () => signIn("u2", "u2");
    await syncCloudNotes({ force: true });
    expect(getAppState().noteById.mobile).toBeUndefined();
    expect(fakes.localDeletes).toEqual([]);
  });

  it("does not bring back a note deleted while the list was loading (S8)", async () => {
    signIn("u1");
    fakes.serverNotes = [serverNote("kept")];
    fakes.onList = () => {
      void noteStore.deleteNote("kept", { deleteAudio: true });
    };
    await syncCloudNotes({ force: true });
    expect(getAppState().noteById.kept).toBeUndefined();
  });

  it("keeps an edit typed while the list was loading (S1)", async () => {
    signIn("u1");
    fakes.serverNotes = [serverNote("gone-audio")];
    fakes.onList = () => {
      void noteStore.updateNote("gone-audio", (note) => {
        note.title = "Typed meanwhile";
        note.cloud!.unsyncedFields.push("title");
      });
    };
    await syncCloudNotes({ force: true });
    expect(getAppState().noteById["gone-audio"]).toMatchObject({
      title: "Typed meanwhile",
      generatedNotes: "Notes.",
    });
  });
});
