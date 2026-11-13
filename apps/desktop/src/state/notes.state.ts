import { Nullable } from "@voquill/types";
import type { MeetingCaptureStatus } from "../repos/meeting-audio.repo";
import type { NoteAskSource } from "../utils/note-search.utils";

export type NoteAskMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources: NoteAskSource[];
  /** Error code. */
  error: Nullable<string>;
  errorDetails: Nullable<Record<string, unknown>>;
  streaming: boolean;
  /** The user stopped the answer before it finished. */
  stopped: boolean;
};

/** The note screen view, kept for the session as the user moves between notes. */
export type NoteView = "notes" | "mine" | "transcript";

/** One Ask conversation, about a note or across all notes. */
export type NoteAskThread = {
  messages: NoteAskMessage[];
  expanded: boolean;
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

export const ALL_NOTES_ASK_KEY = "all";

export const getNoteAskKey = (noteId: Nullable<string>): string =>
  noteId ?? ALL_NOTES_ASK_KEY;

export type NotesState = {
  loaded: boolean;
  /** The account whose cloud notes are loaded; null for local notes only. */
  loadedForUserId: Nullable<string>;
  cloudActivityByNoteId: Record<string, NoteCloudActivity>;
  /** The meeting in progress this session, recording or paused. */
  activeNoteId: Nullable<string>;
  capture: Nullable<MeetingCaptureStatus>;
  importDialogOpen: boolean;
  /** Session Ask threads by note id, or `ALL_NOTES_ASK_KEY` for the list. */
  askThreadByKey: Record<string, NoteAskThread>;
  /** Ask's daily cap is reached until then (ISO time). */
  askLimitResetsAt: Nullable<string>;
  noteView: NoteView;
  /** The device reports a network connection. */
  online: boolean;
};

export const INITIAL_NOTES_STATE: NotesState = {
  loaded: false,
  loadedForUserId: null,
  cloudActivityByNoteId: {},
  activeNoteId: null,
  capture: null,
  importDialogOpen: false,
  askThreadByKey: {},
  askLimitResetsAt: null,
  noteView: "notes",
  online: true,
};
