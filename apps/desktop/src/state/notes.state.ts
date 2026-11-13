import { Nullable } from "@voquill/types";
import type { MeetingCaptureStatus } from "../repos/meeting-audio.repo";
import type { NoteAskSource } from "../utils/note-search.utils";

export type NoteAskMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources: NoteAskSource[];
  error: Nullable<string>;
  streaming: boolean;
};

/** What a cloud note's pipeline is doing right now (not persisted). */
export type NoteCloudActivity =
  | {
      kind: "uploading";
      segmentId: string;
      uploadedBytes: number;
      totalBytes: number;
    }
  | { kind: "waiting-for-connection" }
  | { kind: "server-busy" }
  | { kind: "processing" };

export type NotesState = {
  loaded: boolean;
  /** The account whose cloud notes are loaded; null for local notes only. */
  loadedForUserId: Nullable<string>;
  cloudActivityByNoteId: Record<string, NoteCloudActivity>;
  /** The meeting in progress this session, recording or paused. */
  activeNoteId: Nullable<string>;
  capture: Nullable<MeetingCaptureStatus>;
  importDialogOpen: boolean;
  askDialogOpen: boolean;
  /** Null asks across all notes. */
  askNoteId: Nullable<string>;
  askMessages: NoteAskMessage[];
};

export const INITIAL_NOTES_STATE: NotesState = {
  loaded: false,
  loadedForUserId: null,
  cloudActivityByNoteId: {},
  activeNoteId: null,
  capture: null,
  importDialogOpen: false,
  askDialogOpen: false,
  askNoteId: null,
  askMessages: [],
};
