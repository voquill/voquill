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
  | { type: "done"; sources: NoteAskSource[] }
  | { type: "error"; message: string };

/**
 * Where a note's network-bound work happens. Capture is always local; the
 * pipeline takes over once the user finishes a meeting. Every method is
 * idempotent and safe to call again after a crash.
 */
export abstract class BaseNotePipeline {
  /** Transcribes untranscribed audio and generates notes for a `pending` note. */
  abstract process(noteId: string): Promise<void>;
  /** Re-generates notes from the stored transcript of a `ready` note. */
  abstract regenerate(noteId: string): Promise<void>;
  /** Finishes whatever a restart interrupted for a stored note. */
  abstract resumeAfterRestart(noteId: string): Promise<void>;
  abstract importTranscript(input: NoteImportInput): Promise<void>;
  abstract deleteNote(noteId: string): Promise<void>;
  abstract search(query: string): Promise<NoteSearchResult[]>;
  abstract ask(input: NoteAskInput): AsyncGenerator<NoteAskEvent>;
}
