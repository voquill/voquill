import { invoke } from "@tauri-apps/api/core";
import type {
  Note,
  NoteCloudSync,
  NoteEditableField,
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
  /** JSON object. */
  errorDetails: string | null;
  createdAt: number;
  updatedAt: number;
  cloudOwnerUserId: string | null;
  cloudOnServer: boolean;
  /** Comma-separated `NoteEditableField`s. */
  cloudUnsyncedFields: string;
  cloudProcessRequestedAt: number | null;
  cloudServerUpdatedAt: number | null;
  cloudFetchedUpdatedAt: number | null;
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
  errorCode: string | null;
  errorMessage: string | null;
  /** JSON object. */
  errorDetails: string | null;
  uploadUrl: string | null;
  uploadSizeBytes: number | null;
  uploadComplete: boolean;
};

export type NoteDeletion = {
  noteId: string;
  ownerUserId: string;
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

const toTimestamp = (value: string | null): number | null =>
  value === null ? null : dayjs(value).valueOf();

const fromTimestamp = (value: number | null): string | null =>
  value === null ? null : dayjs(value).toISOString();

const parseDetails = (value: string | null): Record<string, unknown> | null => {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const toError = (
  code: string | null,
  message: string | null,
  details: string | null,
): NoteError | null => {
  if (!code) return null;
  const parsed = parseDetails(details);
  return parsed
    ? { code, message: message ?? "", details: parsed }
    : { code, message: message ?? "" };
};

const toDetails = (error: NoteError | null | undefined) =>
  error?.details ? JSON.stringify(error.details) : null;

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
  errorDetails: toDetails(note.error),
  createdAt: dayjs(note.createdAt).valueOf(),
  updatedAt: dayjs(note.updatedAt).valueOf(),
  cloudOwnerUserId: note.cloud?.ownerUserId ?? null,
  cloudOnServer: note.cloud?.onServer ?? false,
  cloudUnsyncedFields: note.cloud?.unsyncedFields.join(",") ?? "",
  cloudProcessRequestedAt: toTimestamp(note.cloud?.processRequestedAt ?? null),
  cloudServerUpdatedAt: toTimestamp(note.cloud?.serverUpdatedAt ?? null),
  cloudFetchedUpdatedAt: toTimestamp(note.cloud?.fetchedUpdatedAt ?? null),
});

const fromLocalCloudSync = (note: LocalNote): NoteCloudSync | null =>
  note.storage === "cloud"
    ? {
        ownerUserId: note.cloudOwnerUserId ?? "",
        onServer: note.cloudOnServer,
        unsyncedFields: note.cloudUnsyncedFields
          .split(",")
          .filter(Boolean) as NoteEditableField[],
        processRequestedAt: fromTimestamp(note.cloudProcessRequestedAt),
        serverUpdatedAt: fromTimestamp(note.cloudServerUpdatedAt),
        fetchedUpdatedAt: fromTimestamp(note.cloudFetchedUpdatedAt),
      }
    : null;

export const fromLocalNote = (note: LocalNote): Note => {
  const error = toError(note.errorCode, note.errorMessage, note.errorDetails);
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
    cloud: fromLocalCloudSync(note),
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
  errorCode: segment.error?.code ?? null,
  errorMessage: segment.error?.message ?? null,
  errorDetails: toDetails(segment.error),
  uploadUrl: segment.upload?.url ?? null,
  uploadSizeBytes: segment.upload?.sizeBytes ?? null,
  uploadComplete: segment.upload?.complete ?? false,
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
  error: toError(segment.errorCode, segment.errorMessage, segment.errorDetails),
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
  upload: segment.uploadUrl
    ? {
        url: segment.uploadUrl,
        sizeBytes: segment.uploadSizeBytes ?? 0,
        complete: segment.uploadComplete,
      }
    : null,
});

export type NoteSearchArgs = {
  terms: string[];
  matchAll: boolean;
  limit: number;
  /** Whose cloud notes to include besides local notes; null for none. */
  cloudOwnerUserId: string | null;
};

/** The on-device note store, also the local copy of cloud notes. */
export abstract class BaseNoteRepo extends BaseRepo {
  /** Local notes plus the cloud notes of `cloudOwnerUserId`. */
  abstract listNotes(cloudOwnerUserId: string | null): Promise<Note[]>;
  abstract upsertNote(note: Note): Promise<Note>;
  /**
   * Removes the note and its segments. `deleteAudio` also removes every audio
   * file recorded for it (the user deleted it); otherwise files stay on disk
   * for recovery.
   */
  abstract deleteNote(
    noteId: string,
    options: { deleteAudio: boolean },
  ): Promise<void>;
  abstract listSegments(noteId: string): Promise<NoteSegment[]>;
  abstract upsertSegment(segment: NoteSegment): Promise<NoteSegment>;
  abstract deleteSegment(noteId: string, segmentId: string): Promise<void>;
  abstract searchNotes(args: NoteSearchArgs): Promise<NoteSearchCandidate[]>;
  /** Cloud notes deleted here whose server delete is still outstanding. */
  abstract addDeletion(deletion: NoteDeletion): Promise<void>;
  abstract listDeletions(ownerUserId: string): Promise<NoteDeletion[]>;
  abstract removeDeletion(noteId: string): Promise<void>;
}

export class LocalNoteRepo extends BaseNoteRepo {
  async listNotes(cloudOwnerUserId: string | null): Promise<Note[]> {
    const notes = await invoke<LocalNote[]>("note_list", { cloudOwnerUserId });
    return notes.map(fromLocalNote);
  }

  async upsertNote(note: Note): Promise<Note> {
    const stored = await invoke<LocalNote>("note_upsert", {
      note: toLocalNote(note),
    });
    return fromLocalNote(stored);
  }

  async deleteNote(
    noteId: string,
    { deleteAudio }: { deleteAudio: boolean },
  ): Promise<void> {
    await invoke<void>("note_delete", { id: noteId, deleteAudio });
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

  async deleteSegment(noteId: string, segmentId: string): Promise<void> {
    await invoke<void>("note_segment_delete", { noteId, segmentId });
  }

  async searchNotes(args: NoteSearchArgs): Promise<NoteSearchCandidate[]> {
    const candidates = await invoke<LocalNoteSearchCandidate[]>(
      "note_search",
      args,
    );
    return candidates.map((candidate) => ({
      note: fromLocalNote(candidate.note),
      transcript: candidate.transcript,
    }));
  }

  async addDeletion(deletion: NoteDeletion): Promise<void> {
    await invoke<void>("note_deletion_add", { deletion });
  }

  async listDeletions(ownerUserId: string): Promise<NoteDeletion[]> {
    return invoke<NoteDeletion[]>("note_deletion_list", { ownerUserId });
  }

  async removeDeletion(noteId: string): Promise<void> {
    await invoke<void>("note_deletion_remove", { noteId });
  }
}
