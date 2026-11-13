import type { Note, NoteSegment } from "@voquill/types";
import dayjs from "dayjs";
import type { NoteStore } from "../pipelines/local-note.pipeline";
import { getNoteRepo } from "../repos";
import { getAppState, produceAppState } from "../store";
import { getLogger } from "../utils/log.utils";

/**
 * Zustand holds the latest note state; SQLite writes for a note (and its
 * segments) run one at a time in order and always persist the latest state,
 * so concurrent edits from the UI and the pipeline never overwrite each other.
 */
const writeChainByNoteId = new Map<string, Promise<void>>();

const enqueueNoteWrite = (
  noteId: string,
  write: () => Promise<unknown>,
): Promise<void> => {
  const previous = writeChainByNoteId.get(noteId) ?? Promise.resolve();
  const next = previous.then(write).then(() => undefined);
  const settled = next.catch((error) => {
    getLogger().error(`Failed to persist note: ${error}`);
  });
  writeChainByNoteId.set(noteId, settled);
  void settled.then(() => {
    if (writeChainByNoteId.get(noteId) === settled) {
      writeChainByNoteId.delete(noteId);
    }
  });
  return next;
};

const persistNote = (noteId: string) =>
  enqueueNoteWrite(noteId, async () => {
    const note = getAppState().noteById[noteId];
    if (note) {
      await getNoteRepo().upsertNote(note);
    }
  });

const persistSegment = (noteId: string, segmentId: string) =>
  enqueueNoteWrite(noteId, async () => {
    const segment = getAppState().noteSegmentsByNoteId[noteId]?.find(
      (candidate) => candidate.id === segmentId,
    );
    if (segment && getAppState().noteById[noteId]) {
      await getNoteRepo().upsertSegment(segment);
    }
  });

const sortSegments = (segments: NoteSegment[]) =>
  segments.sort((left, right) => left.index - right.index);

export const loadNotes = async (): Promise<Note[]> => {
  const notes = await getNoteRepo().listNotes();
  produceAppState((draft) => {
    for (const note of notes) {
      draft.noteById[note.id] = note;
    }
    draft.notes.loaded = true;
  });
  return notes;
};

export const noteStore: NoteStore = {
  getNote: (noteId) => getAppState().noteById[noteId] ?? null,

  getNotes: () =>
    Object.values(getAppState().noteById).sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    ),

  getSegments: (noteId) => getAppState().noteSegmentsByNoteId[noteId] ?? [],

  loadSegments: async (noteId) => {
    const loaded = getAppState().noteSegmentsByNoteId[noteId];
    if (loaded) {
      return loaded;
    }
    const segments = await getNoteRepo().listSegments(noteId);
    produceAppState((draft) => {
      draft.noteSegmentsByNoteId[noteId] ??= sortSegments(segments);
    });
    return getAppState().noteSegmentsByNoteId[noteId] ?? [];
  },

  insertNote: async (note, segments) => {
    produceAppState((draft) => {
      draft.noteById[note.id] = note;
      draft.noteSegmentsByNoteId[note.id] = sortSegments([...segments]);
    });
    await Promise.all([
      persistNote(note.id),
      ...segments.map((segment) => persistSegment(note.id, segment.id)),
    ]);
  },

  updateNote: async (noteId, recipe) => {
    if (!getAppState().noteById[noteId]) {
      return;
    }
    produceAppState((draft) => {
      const note = draft.noteById[noteId];
      if (note) {
        recipe(note);
        note.updatedAt = dayjs().toISOString();
      }
    });
    await persistNote(noteId);
  },

  updateSegment: async (noteId, segmentId, recipe) => {
    produceAppState((draft) => {
      const segment = draft.noteSegmentsByNoteId[noteId]?.find(
        (candidate) => candidate.id === segmentId,
      );
      if (segment) {
        recipe(segment);
      }
    });
    await persistSegment(noteId, segmentId);
  },

  deleteNote: async (noteId) => {
    produceAppState((draft) => {
      delete draft.noteById[noteId];
      delete draft.noteSegmentsByNoteId[noteId];
    });
    await enqueueNoteWrite(noteId, () => getNoteRepo().deleteNote(noteId));
  },
};

/** Adds a segment to a note whose segments are loaded. */
export const addNoteSegment = async (segment: NoteSegment): Promise<void> => {
  produceAppState((draft) => {
    const segments = (draft.noteSegmentsByNoteId[segment.noteId] ??= []);
    segments.push(segment);
    sortSegments(segments);
  });
  await persistSegment(segment.noteId, segment.id);
};
