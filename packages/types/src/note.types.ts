/**
 * Voquill Notes. Field names follow the `/v1/notes` server contract so a
 * cloud note and a local note share one shape in the apps. `storage`,
 * client statuses, `cloud`, `transcribedMs`, `audioPath` and `upload` are
 * client-side only.
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

export type NoteEditableField = "title" | "personalNotes";

/** Client bookkeeping for a note stored in Voquill cloud. */
export type NoteCloudSync = {
  /** The account the note belongs to; it is only shown to that account. */
  ownerUserId: string;
  /** The server is known to have the note. */
  onServer: boolean;
  /** Edits made on this device that the server has not confirmed yet. */
  unsyncedFields: NoteEditableField[];
  /** When the server last accepted `process` (or `regenerate`/`import`). */
  processRequestedAt: string | null;
  /** The server's `updatedAt` as last seen. */
  serverUpdatedAt: string | null;
  /** The server `updatedAt` that the locally cached segments match. */
  fetchedUpdatedAt: string | null;
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
  /** Null for local notes. */
  cloud: NoteCloudSync | null;
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

/** An upload session for a cloud note's segment audio. */
export type NoteSegmentUpload = {
  /** Resumable session URL; a credential, never log it. */
  url: string;
  sizeBytes: number;
  complete: boolean;
};

export type NoteSegment = {
  id: string;
  noteId: string;
  index: number;
  kind: NoteSegmentKind;
  status: NoteSegmentStatus;
  /** Why the segment is `failed`. */
  error: NoteError | null;
  durationMs: number;
  createdAt: string;
  transcript: NoteTranscript | null;
  /** How much of the segment's audio has a committed transcript. */
  transcribedMs: number;
  /** Local audio file; null for imports and once the audio is deleted. */
  audioPath: string | null;
  upload: NoteSegmentUpload | null;
};
