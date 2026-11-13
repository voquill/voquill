import type {
  NoteError,
  NoteSegment,
  NoteSegmentStatus,
  NoteSource,
  NoteStatus,
  NoteTitleSource,
  NoteTranscript,
} from "@voquill/types";
import type {
  NoteAskEvent,
  NoteAskInput,
} from "../pipelines/base-note.pipeline";
import {
  getNewServerAuthHeaders,
  NEW_SERVER_URL,
} from "../utils/new-server.utils";
import { BaseRepo } from "./base.repo";

/**
 * The `/v1/notes` contract (core `docs/notes.md`). Everything the desktop
 * app knows about the Notes REST API (paths, bodies, error codes, polling
 * rules, upload format) lives in this file.
 */

export type ServerNoteStatus = "draft" | "processing" | "ready" | "failed";
export type ServerSegmentStatus =
  | "uploading"
  | "uploaded"
  | "transcribed"
  | "failed";

export type ServerNoteSegment = {
  id: string;
  index: number;
  kind: "audio" | "import";
  status: ServerSegmentStatus;
  error: NoteError | null;
  durationMs: number;
  createdAt: string;
  transcript: NoteTranscript | null;
};

export type ServerNote = {
  id: string;
  title: string;
  titleSource: NoteTitleSource;
  status: ServerNoteStatus;
  error: NoteError | null;
  source: NoteSource;
  personalNotes: string;
  generatedNotes: string | null;
  durationMs: number;
  createdAt: string;
  updatedAt: string;
  segments?: ServerNoteSegment[];
};

export type ServerNoteWithSegments = ServerNote & {
  segments: ServerNoteSegment[];
};

export type ServerNoteSearchResult = {
  note: ServerNote;
  snippet: string;
  score: number;
};

/** Meeting audio is uploaded as recorded: 16 kHz mono 16-bit WAV. */
export const NOTE_AUDIO_CONTENT_TYPE = "audio/wav";

/** The server's fixed id for an imported note's only segment. */
const SERVER_IMPORT_SEGMENT_ID = "import";

/** Polling guidance from the contract. */
export const NOTE_POLL_INTERVAL_MS = 4_000;
export const NOTE_SLOW_POLL_INTERVAL_MS = 30_000;
export const NOTE_SLOW_POLL_AFTER_MS = 5 * 60_000;
/** A `processing` note older than this since `process` gets `process` again. */
export const NOTE_PROCESSING_STALE_MS = 10 * 60_000;

const LIST_PAGE_SIZE = 100;
const SEARCH_LIMIT = 20;

export class NotesApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly segmentIds: string[];

  constructor(
    status: number,
    code: string,
    message: string,
    segmentIds: string[] = [],
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.segmentIds = segmentIds;
  }
}

/** The request never got an HTTP response (offline, DNS, TLS, reset). */
export class NotesNetworkError extends Error {}

/**
 * How the client treats an error code:
 * - `retry`: transient (network, 5xx, queue); retry the same call with backoff.
 * - `busy`: the account is processing too much at once; retry later.
 * - `blocked`: needs the user (plan, quota, limits, bad audio); never auto-retried.
 * - `missing`: the note or segment is gone on the server.
 */
export type NotesErrorHandling = "retry" | "busy" | "blocked" | "missing";

const BLOCKING_CODES = new Set([
  "member_not_found",
  "word_quota_exceeded",
  "audio_quota_exceeded",
  "regenerate_cooldown",
  "segment_too_large",
  "segment_too_long",
  "too_many_segments",
  "note_too_long",
  "unsupported_content_type",
  "unsupported_audio",
  "note_is_import",
  "note_exists",
  "transcript_unavailable",
  "payload_too_large",
  "invalid_request",
]);

const BUSY_CODES = new Set(["too_many_processing_notes"]);

export const getNotesErrorHandling = (error: unknown): NotesErrorHandling => {
  if (error instanceof NotesNetworkError) return "retry";
  if (!(error instanceof NotesApiError)) return "blocked";
  if (BUSY_CODES.has(error.code)) return "busy";
  if (BLOCKING_CODES.has(error.code)) return "blocked";
  if (error.code === "note_not_found") return "missing";
  if (error.status >= 500 || error.status === 429 || error.status === 401) {
    return "retry";
  }
  return "blocked";
};

export const toClientNoteStatus = (status: ServerNoteStatus): NoteStatus =>
  status === "draft" ? "paused" : status;

/** Segment ids are unique per note on the server but per device here. */
export const toLocalSegmentId = (noteId: string, serverSegmentId: string) =>
  serverSegmentId === SERVER_IMPORT_SEGMENT_ID
    ? `${noteId}-import`
    : serverSegmentId;

export const fromServerSegment = (
  noteId: string,
  segment: ServerNoteSegment,
): Omit<NoteSegment, "audioPath" | "upload"> => ({
  id: toLocalSegmentId(noteId, segment.id),
  noteId,
  index: segment.index,
  kind: segment.kind,
  status: segment.status as NoteSegmentStatus,
  error: segment.error,
  durationMs: segment.durationMs,
  createdAt: segment.createdAt,
  transcript: segment.transcript,
  transcribedMs: segment.status === "transcribed" ? segment.durationMs : 0,
});

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type CloudNoteRepoOptions = {
  baseUrl?: string;
  fetch?: FetchLike;
  getAuthHeaders?: (forceRefresh: boolean) => Promise<Record<string, string>>;
};

type SseEvent = { event: string; data: string };

/** Parses `text/event-stream` frames; comment lines are dropped. */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];

  const takeLine = (): string | null => {
    const newline = buffer.indexOf("\n");
    if (newline === -1) return null;
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    return line;
  };

  for (;;) {
    const { value, done } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    for (let line = takeLine(); line !== null; line = takeLine()) {
      if (line === "") {
        if (data.length > 0) {
          yield { event, data: data.join("\n") };
        }
        event = "message";
        data = [];
      } else if (line.startsWith(":")) {
        continue;
      } else {
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const fieldValue =
          colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = fieldValue;
        else if (field === "data") data.push(fieldValue);
      }
    }
    if (done) return;
  }
}

const readApiError = async (response: Response): Promise<NotesApiError> => {
  try {
    const body = (await response.json()) as {
      error?: {
        code?: string;
        message?: string;
        details?: { segmentIds?: string[] };
      };
    };
    return new NotesApiError(
      response.status,
      body.error?.code ?? "unknown",
      body.error?.message ?? response.statusText,
      body.error?.details?.segmentIds ?? [],
    );
  } catch {
    return new NotesApiError(response.status, "unknown", response.statusText);
  }
};

/** REST client for `/v1/notes` on the Voquill server. */
export class CloudNoteRepo extends BaseRepo {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly getAuthHeaders: (
    forceRefresh: boolean,
  ) => Promise<Record<string, string>>;

  constructor(options: CloudNoteRepoOptions = {}) {
    super();
    this.baseUrl = options.baseUrl ?? NEW_SERVER_URL;
    this.fetchImpl =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.getAuthHeaders = options.getAuthHeaders ?? getNewServerAuthHeaders;
  }

  private async send(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const attempt = async (forceRefresh: boolean) => {
      const headers = await this.getAuthHeaders(forceRefresh);
      try {
        return await this.fetchImpl(`${this.baseUrl}/v1/notes${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        throw new NotesNetworkError(
          error instanceof Error ? error.message : String(error),
        );
      }
    };
    let response = await attempt(false);
    if (response.status === 401) {
      response = await attempt(true);
    }
    if (!response.ok) {
      throw await readApiError(response);
    }
    return response;
  }

  private async json<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await this.send(method, path, body);
    return (await response.json()) as T;
  }

  async listNotesPage(
    cursor: string | null,
  ): Promise<{ notes: ServerNote[]; nextCursor: string | null }> {
    const query = new URLSearchParams({ limit: String(LIST_PAGE_SIZE) });
    if (cursor) query.set("cursor", cursor);
    return this.json("GET", `?${query}`);
  }

  async listAllNotes(): Promise<ServerNote[]> {
    const notes: ServerNote[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.listNotesPage(cursor);
      notes.push(...page.notes);
      cursor = page.nextCursor;
    } while (cursor);
    return notes;
  }

  async getNote(noteId: string): Promise<ServerNoteWithSegments> {
    const { note } = await this.json<{ note: ServerNote }>("GET", `/${noteId}`);
    return { ...note, segments: note.segments ?? [] };
  }

  /** Creates the note as a draft or updates client-owned fields. */
  async putNote(
    noteId: string,
    body: {
      title: string;
      titleSource: "default" | "user";
      personalNotes: string;
      createdAt: string;
    },
  ): Promise<ServerNote> {
    const { note } = await this.json<{ note: ServerNote }>(
      "PUT",
      `/${noteId}`,
      body,
    );
    return note;
  }

  async patchNote(
    noteId: string,
    body: { title?: string; personalNotes?: string },
  ): Promise<ServerNote> {
    const { note } = await this.json<{ note: ServerNote }>(
      "PATCH",
      `/${noteId}`,
      body,
    );
    return note;
  }

  async deleteNote(noteId: string): Promise<void> {
    await this.send("DELETE", `/${noteId}`);
  }

  /** Returns the resumable upload session URL for one audio segment. */
  async requestSegmentUpload(
    noteId: string,
    segmentId: string,
    body: {
      durationMs: number;
      sizeBytes: number;
      index: number;
      language?: string;
    },
  ): Promise<string> {
    const { uploadUrl } = await this.json<{ uploadUrl: string }>(
      "POST",
      `/${noteId}/segments/${segmentId}/upload`,
      { contentType: NOTE_AUDIO_CONTENT_TYPE, ...body },
    );
    return uploadUrl;
  }

  /** Drops an untranscribed segment whose audio is gone. */
  async deleteSegment(noteId: string, segmentId: string): Promise<void> {
    await this.send("DELETE", `/${noteId}/segments/${segmentId}`);
  }

  async processNote(
    noteId: string,
    body: { title?: string; personalNotes?: string },
  ): Promise<ServerNote> {
    const { note } = await this.json<{ note: ServerNote }>(
      "POST",
      `/${noteId}/process`,
      body,
    );
    return note;
  }

  async regenerateNote(noteId: string): Promise<ServerNote> {
    const { note } = await this.json<{ note: ServerNote }>(
      "POST",
      `/${noteId}/regenerate`,
      {},
    );
    return note;
  }

  async importNote(body: {
    id: string;
    transcript: string;
    title?: string;
    createdAt: string;
  }): Promise<ServerNote> {
    const { note } = await this.json<{ note: ServerNote }>(
      "POST",
      "/import",
      body,
    );
    return note;
  }

  async search(query: string): Promise<ServerNoteSearchResult[]> {
    const params = new URLSearchParams({
      q: query.trim().slice(0, 500),
      limit: String(SEARCH_LIMIT),
    });
    const { results } = await this.json<{
      results: ServerNoteSearchResult[];
    }>("GET", `/search?${params}`);
    return results;
  }

  /**
   * Streams an answer. Errors before the stream starts throw a
   * `NotesApiError`; a failure mid-stream or a dropped connection ends with
   * an `error` event after whatever text already arrived.
   */
  async *ask({
    question,
    noteId,
    history,
  }: NoteAskInput): AsyncGenerator<NoteAskEvent> {
    const response = await this.send("POST", "/ask", {
      question,
      ...(noteId ? { noteId } : {}),
      history: history.slice(-20),
      stream: true,
    });
    if (!response.body) {
      yield { type: "error", message: "ask_incomplete" };
      return;
    }

    let sources: { noteId: string; title: string }[] = [];
    try {
      for await (const { event, data } of parseSseStream(response.body)) {
        const payload = JSON.parse(data) as {
          sources?: typeof sources;
          text?: string;
          answer?: string;
          code?: string;
        };
        if (event === "sources") {
          sources = payload.sources ?? [];
          yield { type: "sources", sources };
        } else if (event === "delta") {
          yield { type: "delta", text: payload.text ?? "" };
        } else if (event === "done") {
          yield { type: "done", answer: payload.answer ?? "", sources };
          return;
        } else if (event === "error") {
          yield { type: "error", message: payload.code ?? "ask_failed" };
          return;
        }
      }
    } catch {
      // The connection dropped mid-answer.
    }
    yield { type: "error", message: "ask_incomplete" };
  }
}
