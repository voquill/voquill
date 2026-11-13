/**
 * Voquill Notes. Field names follow the `/v1/notes` server contract so a
 * cloud note and a local note share one shape in the apps. `storage`,
 * client statuses, `transcribedMs` and `audioPath` are client-side only.
 */

export type NoteStorage = "local" | "cloud";

/**
 * Client lifecycle of a note. The server's `draft` maps to `recording` or
 * `paused` depending on whether this device is capturing; `pending` means
 * processing was requested but has not started yet.
 */
export type NoteStatus =
  | "recording"
  | "paused"
  | "pending"
  | "processing"
  | "ready"
  | "failed";

export type NoteTitleSource = "default" | "ai" | "user";

export type NoteSource = "recording" | "import";

export type NoteError = {
  code: string;
  message: string;
};

export type Note = {
  id: string;
  storage: NoteStorage;
  status: NoteStatus;
  title: string;
  titleSource: NoteTitleSource;
  error: NoteError | null;
  source: NoteSource;
  personalNotes: string;
  generatedNotes: string | null;
  durationMs: number;
  createdAt: string;
  updatedAt: string;
};

export type NoteUtterance = {
  startMs: number;
  endMs: number;
  speaker: number | null;
  text: string;
};

export type NoteTranscript = {
  text: string;
  utterances: NoteUtterance[];
};

export type NoteSegmentKind = "audio" | "import";

export type NoteSegmentStatus =
  | "recording"
  | "recorded"
  | "uploading"
  | "uploaded"
  | "transcribed"
  | "failed";

export type NoteSegment = {
  id: string;
  noteId: string;
  index: number;
  kind: NoteSegmentKind;
  status: NoteSegmentStatus;
  durationMs: number;
  createdAt: string;
  transcript: NoteTranscript | null;
  /** How much of the segment's audio has a committed transcript. */
  transcribedMs: number;
  /** Local audio file; null for imports and once the audio is deleted. */
  audioPath: string | null;
};
