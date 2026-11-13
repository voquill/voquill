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

export type NotesState = {
  loaded: boolean;
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
  activeNoteId: null,
  capture: null,
  importDialogOpen: false,
  askDialogOpen: false,
  askNoteId: null,
  askMessages: [],
};
