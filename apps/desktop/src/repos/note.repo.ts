import { invoke } from "@tauri-apps/api/core";
import type {
  Note,
  NoteError,
  NoteSegment,
  NoteSegmentKind,
  NoteSegmentStatus,
  NoteSource,
  NoteStatus,
  NoteStorage,
  NoteTitleSource,
  NoteUtterance,
} from "@voquill/types";
import dayjs from "dayjs";
import { BaseRepo } from "./base.repo";

export type LocalNote = {
  id: string;
  storage: string;
  status: string;
  title: string;
  titleSource: string;
  source: string;
  personalNotes: string;
  generatedNotes: string | null;
  durationMs: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
};

export type LocalNoteSegment = {
  id: string;
  noteId: string;
  segmentIndex: number;
  kind: string;
  status: string;
  durationMs: number;
  audioPath: string | null;
  transcribedMs: number;
  transcriptText: string | null;
  transcriptUtterances: string | null;
  createdAt: number;
};

type LocalNoteSearchCandidate = {
  note: LocalNote;
  transcript: string;
};

export type NoteSearchCandidate = {
  note: Note;
  transcript: string;
};

export const toLocalNote = (note: Note): LocalNote => ({
  id: note.id,
  storage: note.storage,
  status: note.status,
  title: note.title,
  titleSource: note.titleSource,
  source: note.source,
  personalNotes: note.personalNotes,
  generatedNotes: note.generatedNotes,
  durationMs: Math.round(note.durationMs),
  errorCode: note.error?.code ?? null,
  errorMessage: note.error?.message ?? null,
  createdAt: dayjs(note.createdAt).valueOf(),
  updatedAt: dayjs(note.updatedAt).valueOf(),
});

export const fromLocalNote = (note: LocalNote): Note => {
  const error: NoteError | null = note.errorCode
    ? { code: note.errorCode, message: note.errorMessage ?? "" }
    : null;
  return {
    id: note.id,
    storage: note.storage as NoteStorage,
    status: note.status as NoteStatus,
    title: note.title,
    titleSource: note.titleSource as NoteTitleSource,
    source: note.source as NoteSource,
    personalNotes: note.personalNotes,
    generatedNotes: note.generatedNotes,
    durationMs: note.durationMs,
    error,
    createdAt: dayjs(note.createdAt).toISOString(),
    updatedAt: dayjs(note.updatedAt).toISOString(),
  };
};

export const toLocalNoteSegment = (segment: NoteSegment): LocalNoteSegment => ({
  id: segment.id,
  noteId: segment.noteId,
  segmentIndex: segment.index,
  kind: segment.kind,
  status: segment.status,
  durationMs: Math.round(segment.durationMs),
  audioPath: segment.audioPath,
  transcribedMs: Math.round(segment.transcribedMs),
  transcriptText: segment.transcript?.text ?? null,
  transcriptUtterances: segment.transcript
    ? JSON.stringify(segment.transcript.utterances)
    : null,
  createdAt: dayjs(segment.createdAt).valueOf(),
});

const parseUtterances = (value: string | null): NoteUtterance[] => {
  if (!value) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as NoteUtterance[]) : [];
  } catch {
    return [];
  }
};

export const fromLocalNoteSegment = (
  segment: LocalNoteSegment,
): NoteSegment => ({
  id: segment.id,
  noteId: segment.noteId,
  index: segment.segmentIndex,
  kind: segment.kind as NoteSegmentKind,
  status: segment.status as NoteSegmentStatus,
  durationMs: segment.durationMs,
  audioPath: segment.audioPath,
  transcribedMs: segment.transcribedMs,
  transcript:
    segment.transcriptText === null
      ? null
      : {
          text: segment.transcriptText,
          utterances: parseUtterances(segment.transcriptUtterances),
        },
  createdAt: dayjs(segment.createdAt).toISOString(),
});

/** The on-device note store, also the local copy of cloud notes. */
export abstract class BaseNoteRepo extends BaseRepo {
  abstract listNotes(): Promise<Note[]>;
  abstract upsertNote(note: Note): Promise<Note>;
  /** Removes the note, its segments and any local audio recorded for it. */
  abstract deleteNote(noteId: string): Promise<void>;
  abstract listSegments(noteId: string): Promise<NoteSegment[]>;
  abstract upsertSegment(segment: NoteSegment): Promise<NoteSegment>;
  abstract searchNotes(args: {
    terms: string[];
    matchAll: boolean;
    limit: number;
  }): Promise<NoteSearchCandidate[]>;
}

export class LocalNoteRepo extends BaseNoteRepo {
  async listNotes(): Promise<Note[]> {
    const notes = await invoke<LocalNote[]>("note_list");
    return notes.map(fromLocalNote);
  }

  async upsertNote(note: Note): Promise<Note> {
    const stored = await invoke<LocalNote>("note_upsert", {
      note: toLocalNote(note),
    });
    return fromLocalNote(stored);
  }

  async deleteNote(noteId: string): Promise<void> {
    await invoke<void>("note_delete", { id: noteId });
  }

  async listSegments(noteId: string): Promise<NoteSegment[]> {
    const segments = await invoke<LocalNoteSegment[]>("note_segment_list", {
      noteId,
    });
    return segments.map(fromLocalNoteSegment);
  }

  async upsertSegment(segment: NoteSegment): Promise<NoteSegment> {
    const stored = await invoke<LocalNoteSegment>("note_segment_upsert", {
      segment: toLocalNoteSegment(segment),
    });
    return fromLocalNoteSegment(stored);
  }

  async searchNotes({
    terms,
    matchAll,
    limit,
  }: {
    terms: string[];
    matchAll: boolean;
    limit: number;
  }): Promise<NoteSearchCandidate[]> {
    const candidates = await invoke<LocalNoteSearchCandidate[]>("note_search", {
      terms,
      matchAll,
      limit,
    });
    return candidates.map((candidate) => ({
      note: fromLocalNote(candidate.note),
      transcript: candidate.transcript,
    }));
  }
}
