import type {
  NoteAskSource,
  NoteSearchResult,
} from "../utils/note-search.utils";

export type NoteImportInput = {
  id: string;
  transcript: string;
  title: string | null;
  defaultTitle: string;
};

export type NoteAskHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export type NoteAskInput = {
  question: string;
  noteId: string | null;
  history: NoteAskHistoryMessage[];
};

/** Mirrors the server's `POST /v1/notes/ask` stream events. */
export type NoteAskEvent =
  | { type: "sources"; sources: NoteAskSource[] }
  | { type: "delta"; text: string }
  | { type: "done"; answer: string; sources: NoteAskSource[] }
  | { type: "error"; message: string };

/**
 * Where a note's network-bound work happens. Capture is always local; the
 * pipeline takes over once the user finishes a meeting. Every method is
 * idempotent and safe to call again after a crash.
 */
export abstract class BaseNotePipeline {
  /** Transcribes untranscribed audio and generates notes for a `pending` note. */
  abstract process(noteId: string): Promise<void>;
  /**
   * Re-generates notes from the stored transcript of a `ready` note. Throws
   * when the request is refused (the note then stays as it was).
   */
  abstract regenerate(noteId: string): Promise<void>;
  /** Sends title / My notes edits made on this device, if the storage needs it. */
  abstract saveEdits(noteId: string): Promise<void>;
  /** Brings the stored copy of a note (with its segments) up to date. */
  abstract refresh(noteId: string): Promise<void>;
  /** Finishes whatever a restart interrupted for a stored note. */
  abstract resumeAfterRestart(noteId: string): Promise<void>;
  abstract importTranscript(input: NoteImportInput): Promise<void>;
  abstract deleteNote(noteId: string): Promise<void>;
  abstract search(query: string): Promise<NoteSearchResult[]>;
  abstract ask(input: NoteAskInput): AsyncGenerator<NoteAskEvent>;
}
