import type { Note, NoteError, NoteSegment } from "@voquill/types";
import dayjs from "dayjs";
import {
  getNotesErrorHandling,
  NOTE_AUDIO_CONTENT_TYPE,
  NOTE_POLL_INTERVAL_MS,
  NOTE_PROCESSING_STALE_MS,
  NOTE_SLOW_POLL_AFTER_MS,
  NOTE_SLOW_POLL_INTERVAL_MS,
  NotesApiError,
  NotesNetworkError,
  segmentNeedsReupload,
  type CloudNoteRepo,
  type ServerNote,
  type ServerNoteWithSegments,
} from "../repos/cloud-note.repo";
import type { MeetingAudioRepo } from "../repos/meeting-audio.repo";
import type { BaseNoteRepo } from "../repos/note.repo";
import type { NoteCloudActivity } from "../state/notes.state";
import { getLogger } from "../utils/log.utils";
import type { NoteSearchResult } from "../utils/note-search.utils";
import { canTransitionNote, transitionNote } from "../utils/note-state.utils";
import {
  mergeNoteSearchResults,
  mergeServerNote,
  mergeServerSegments,
} from "../utils/note-sync.utils";
import {
  BaseNotePipeline,
  type NoteAskEvent,
  type NoteAskInput,
  type NoteImportInput,
} from "./base-note.pipeline";
import { searchLocalNotes, type NoteStore } from "./local-note.pipeline";

export type CloudNoteApi = Pick<
  CloudNoteRepo,
  | "getNote"
  | "putNote"
  | "patchNote"
  | "deleteNote"
  | "requestSegmentUpload"
  | "deleteSegment"
  | "processNote"
  | "regenerateNote"
  | "importNote"
  | "search"
  | "ask"
>;

export type Connectivity = {
  isOnline(): boolean;
  /** Resolves once the device reports a network connection. */
  waitUntilOnline(): Promise<void>;
};

export type CloudNotePipelineDeps = {
  store: NoteStore;
  repo: Pick<BaseNoteRepo, "searchNotes" | "addDeletion">;
  api: CloudNoteApi;
  audio: Pick<
    MeetingAudioRepo,
    "getFileSize" | "uploadResumable" | "cancelUpload" | "deleteSegmentAudio"
  >;
  connectivity: Connectivity;
  /** Waits `ms`, returning early when connectivity comes back. */
  sleep(ms: number): Promise<void>;
  now(): number;
  getCloudNotesUserId(): string | null;
  setActivity(noteId: string, activity: NoteCloudActivity | null): void;
  /** Called after a note settled, so the list can refresh. */
  onSettled(noteId: string): void;
  /** Resolves when no dictation is running, so background work never competes with it. */
  yieldToDictation(): Promise<void>;
};

/** The note was deleted, or its account signed out: stop without failing it. */
class NoteUnavailableError extends Error {}

/** A failure the user has to act on; recorded on the note, never auto-retried. */
class NoteBlockedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const MAX_SERVER_RETRIES = 6;
const BUSY_WAIT_MS = 30_000;
/** Upload passes are this size so a dictation never waits behind a long upload. */
const UPLOAD_PASS_BYTES = 8 * 1024 * 1024;
const MAX_BACKOFF_MS = 60_000;
const MAX_UPLOAD_SESSIONS = 3;
const MAX_AUDIO_MISSING_ROUNDS = 3;

const backoffMs = (attempt: number) =>
  Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(attempt, 6));

const toNoteError = (error: unknown): NoteError => {
  if (error instanceof NotesApiError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof NoteBlockedError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof NotesNetworkError) {
    return { code: "network_unavailable", message: error.message };
  }
  return {
    code: "unknown",
    message: error instanceof Error ? error.message : String(error),
  };
};

export class CloudNotePipeline extends BaseNotePipeline {
  private readonly deps: CloudNotePipelineDeps;
  private readonly runningNoteIds = new Set<string>();

  constructor(deps: CloudNotePipelineDeps) {
    super();
    this.deps = deps;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Sends a finished (`pending`) note to the server and follows it to
   * `ready`: create it, upload every segment that is not on the server,
   * request processing, poll, store the result, then release the audio.
   * Each step is idempotent, so a restart simply runs this again.
   */
  async process(noteId: string): Promise<void> {
    const note = this.deps.store.getNote(noteId);
    if (this.runningNoteIds.has(noteId) || note?.status !== "pending") {
      return;
    }
    await this.run(noteId, async () => {
      await this.deps.store.loadSegments(noteId);
      if (note.source === "import" && !note.cloud?.onServer) {
        await this.sendImport(noteId);
      } else {
        await this.pushNote(noteId);
        await this.uploadSegments(noteId);
        await this.requestProcessing(noteId);
      }
      await this.settle(noteId);
    });
  }

  async regenerate(noteId: string): Promise<void> {
    const note = this.deps.store.getNote(noteId);
    if (this.runningNoteIds.has(noteId) || note?.status !== "ready") {
      return;
    }
    this.assertOwned(noteId);
    await this.pushNote(noteId);
    await this.request(noteId, () => this.deps.api.regenerateNote(noteId));
    await this.deps.store.updateNote(noteId, (draft) => {
      draft.status = transitionNote(
        transitionNote(draft.status, "regenerate"),
        "start-processing",
      );
      this.markProcessRequested(draft);
    });
    void this.run(noteId, () => this.settle(noteId));
  }

  async resumeAfterRestart(noteId: string): Promise<void> {
    const note = this.deps.store.getNote(noteId);
    if (
      !note?.cloud ||
      note.cloud.ownerUserId !== this.deps.getCloudNotesUserId()
    ) {
      return;
    }
    if (note.status === "pending") {
      await this.process(noteId);
      return;
    }
    if (note.cloud.unsyncedFields.length > 0) {
      await this.saveEdits(noteId);
    }
    if (note.status === "ready") {
      const segments = await this.deps.store.loadSegments(noteId);
      if (segments.some((segment) => segment.audioPath !== null)) {
        await this.refresh(noteId);
      }
    }
  }

  async saveEdits(noteId: string): Promise<void> {
    try {
      await this.pushNote(noteId);
    } catch (error) {
      if (!(error instanceof NoteUnavailableError)) {
        getLogger().warning(
          `Saving note edits failed (${toNoteError(error).code})`,
        );
      }
    }
  }

  /** Fetches the full note and stores it; releases audio a ready note no longer needs. */
  async refresh(noteId: string): Promise<void> {
    const note = this.deps.store.getNote(noteId);
    if (!note?.cloud?.onServer || !this.deps.connectivity.isOnline()) {
      await this.deps.store.loadSegments(noteId);
      return;
    }
    try {
      this.assertOwned(noteId);
      await this.deps.store.loadSegments(noteId);
      const server = await this.deps.api.getNote(noteId);
      await this.applyServerNote(noteId, server);
      await this.releaseTranscribedAudio(noteId, server);
    } catch (error) {
      if (error instanceof NotesApiError && error.code === "note_not_found") {
        return;
      }
      if (!(error instanceof NoteUnavailableError)) {
        getLogger().warning(
          `Refreshing a cloud note failed (${toNoteError(error).code})`,
        );
      }
    }
  }

  async importTranscript({
    id,
    transcript,
    title,
    defaultTitle,
  }: NoteImportInput): Promise<void> {
    const ownerUserId = this.deps.getCloudNotesUserId();
    if (!ownerUserId) {
      throw new Error("Sign in to import into Voquill cloud");
    }
    const now = dayjs().toISOString();
    const userTitle = title?.trim() ?? "";
    await this.deps.store.insertNote(
      {
        id,
        storage: "cloud",
        status: "pending",
        title: userTitle || defaultTitle,
        titleSource: userTitle ? "user" : "default",
        error: null,
        source: "import",
        personalNotes: "",
        generatedNotes: null,
        durationMs: 0,
        createdAt: now,
        updatedAt: now,
        cloud: {
          ownerUserId,
          onServer: false,
          unsyncedFields: [],
          processRequestedAt: null,
          serverUpdatedAt: null,
          fetchedUpdatedAt: null,
        },
      },
      [
        {
          id: `${id}-import`,
          noteId: id,
          index: 0,
          kind: "import",
          status: "transcribed",
          error: null,
          durationMs: 0,
          createdAt: now,
          transcript: { text: transcript.trim(), utterances: [] },
          transcribedMs: 0,
          audioPath: null,
          upload: null,
        },
      ],
    );
    await this.process(id);
  }

  /**
   * Deletes on the server, then here. The delete is remembered until a sync
   * sees the server without the note, so a request that was still in flight
   * (an upload session creates a draft) cannot bring it back.
   */
  async deleteNote(noteId: string): Promise<void> {
    const { store, api, repo, audio } = this.deps;
    const note = store.getNote(noteId);
    for (const segment of store.getSegments(noteId)) {
      void audio.cancelUpload(segment.id).catch(() => undefined);
    }
    const ownerUserId = note?.cloud?.ownerUserId;
    if (ownerUserId) {
      await repo.addDeletion({
        noteId,
        ownerUserId,
        createdAt: this.deps.now(),
      });
      await api.deleteNote(noteId).catch(() => undefined);
    }
    await store.deleteNote(noteId, { deleteAudio: true });
  }

  /**
   * Retries a segment the server could not transcribe: `process` alone, or
   * after uploading it again when its error says the server lacks the audio.
   */
  async retrySegment(noteId: string, segmentId: string): Promise<void> {
    await this.deps.store.updateSegment(noteId, segmentId, (segment) => {
      if (segmentNeedsReupload(segment)) {
        segment.upload = null;
      }
      segment.error = null;
    });
    await this.deps.store.updateNote(noteId, (note) => {
      note.status = transitionNote(note.status, "retry");
      note.error = null;
    });
    await this.process(noteId);
  }

  /** Gives up on a segment whose audio is lost; the rest of the note stays. */
  async dropSegment(noteId: string, segmentId: string): Promise<void> {
    this.assertOwned(noteId);
    const { store, api, audio } = this.deps;
    const segment = store.getSegments(noteId).find((s) => s.id === segmentId);
    if (!segment || segment.status === "transcribed") {
      return;
    }
    await this.request(noteId, async () => {
      try {
        await api.deleteSegment(noteId, segmentId);
      } catch (error) {
        if (!(error instanceof NotesApiError && error.status === 404)) {
          throw error;
        }
      }
    });
    if (segment.audioPath) {
      await audio.deleteSegmentAudio(segment.audioPath);
    }
    await store.removeSegment(noteId, segmentId);
    await store.updateNote(noteId, (note) => {
      note.durationMs = store
        .getSegments(noteId)
        .reduce((total, current) => total + current.durationMs, 0);
    });
  }

  async search(query: string): Promise<NoteSearchResult[]> {
    const { repo, api, connectivity } = this.deps;
    const ownerUserId = this.deps.getCloudNotesUserId();
    const [local, remote] = await Promise.all([
      searchLocalNotes(repo, query, ownerUserId),
      ownerUserId && connectivity.isOnline() && query.trim()
        ? api.search(query).catch(() => [])
        : Promise.resolve([]),
    ]);
    const remoteResults: NoteSearchResult[] = [];
    for (const result of remote) {
      let note = this.deps.store.getNote(result.note.id);
      if (!note && ownerUserId) {
        note = mergeServerNote(null, result.note, ownerUserId);
        await this.deps.store.putNote(note);
      }
      if (note) {
        remoteResults.push({
          note,
          snippet: result.snippet,
          score: result.score,
        });
      }
    }
    return mergeNoteSearchResults(remoteResults, local);
  }

  async *ask(input: NoteAskInput): AsyncGenerator<NoteAskEvent> {
    if (!this.deps.getCloudNotesUserId()) {
      yield { type: "error", message: "signed_out" };
      return;
    }
    if (!this.deps.connectivity.isOnline()) {
      yield { type: "error", message: "network_unavailable" };
      return;
    }
    try {
      yield* this.deps.api.ask(input);
    } catch (error) {
      const noteError = toNoteError(error);
      yield {
        type: "error",
        message: noteError.code,
        details: noteError.details ?? undefined,
      };
    }
  }

  // ── Steps ─────────────────────────────────────────────────────────────

  private async run(noteId: string, task: () => Promise<void>) {
    if (this.runningNoteIds.has(noteId)) {
      return;
    }
    this.runningNoteIds.add(noteId);
    try {
      await task();
    } catch (error) {
      const gone =
        error instanceof NoteUnavailableError ||
        getNotesErrorHandling(error) === "missing" ||
        !this.deps.store.getNote(noteId);
      if (gone) {
        return;
      }
      if (error instanceof NotesApiError && error.code === "note_deleted") {
        // Deleted on another device. Drop this copy, unless it holds audio
        // the server never got: then keep it (as failed) and say so.
        const hasUnsentAudio = this.deps.store
          .getSegments(noteId)
          .some((segment) => segment.audioPath !== null);
        if (!hasUnsentAudio) {
          await this.deps.store.deleteNote(noteId, { deleteAudio: false });
          return;
        }
      }
      const noteError = toNoteError(error);
      getLogger().error(`Cloud note processing stopped (${noteError.code})`);
      await this.deps.store.updateNote(noteId, (note) => {
        if (canTransitionNote(note.status, "fail")) {
          note.status = transitionNote(note.status, "fail");
        }
        note.error = noteError;
      });
    } finally {
      this.runningNoteIds.delete(noteId);
      this.deps.setActivity(noteId, null);
      this.deps.onSettled(noteId);
    }
  }

  private assertOwned(noteId: string): Note {
    const note = this.deps.store.getNote(noteId);
    if (
      !note?.cloud ||
      note.cloud.ownerUserId !== this.deps.getCloudNotesUserId()
    ) {
      throw new NoteUnavailableError();
    }
    return note;
  }

  /**
   * Runs one API call with the contract's retry rules: network errors wait
   * for the connection (as long as it takes), server errors back off a
   * bounded number of times, "busy" waits a bounded number of times, and
   * anything that needs the user throws.
   */
  private async request<T>(noteId: string, call: () => Promise<T>): Promise<T> {
    let serverFailures = 0;
    let networkFailures = 0;
    for (;;) {
      this.assertOwned(noteId);
      if (!this.deps.connectivity.isOnline()) {
        this.deps.setActivity(noteId, { kind: "waiting-for-connection" });
        await this.deps.connectivity.waitUntilOnline();
        continue;
      }
      try {
        return await call();
      } catch (error) {
        switch (getNotesErrorHandling(error)) {
          case "retry":
            if (error instanceof NotesNetworkError) {
              this.deps.setActivity(noteId, { kind: "waiting-for-connection" });
              await this.deps.sleep(backoffMs(networkFailures++));
              continue;
            }
            if (++serverFailures > MAX_SERVER_RETRIES) throw error;
            await this.deps.sleep(backoffMs(serverFailures));
            continue;
          case "busy":
            // Queued behind the account's other notes; clears on its own.
            this.deps.setActivity(noteId, { kind: "server-busy" });
            await this.deps.sleep(
              error instanceof NotesApiError && error.retryAfterSeconds
                ? Math.min(error.retryAfterSeconds * 1000, MAX_BACKOFF_MS)
                : BUSY_WAIT_MS,
            );
            continue;
          default:
            throw error;
        }
      }
    }
  }

  private markProcessRequested(note: Note) {
    if (note.cloud) {
      note.cloud.processRequestedAt = dayjs(this.deps.now()).toISOString();
    }
  }

  private async confirmServerNote(
    noteId: string,
    server: ServerNote,
    sent: Partial<Pick<Note, "title" | "personalNotes">>,
  ) {
    await this.deps.store.updateNote(noteId, (note) => {
      if (!note.cloud) return;
      note.cloud.onServer = true;
      note.cloud.serverUpdatedAt = server.updatedAt;
      note.cloud.unsyncedFields = note.cloud.unsyncedFields.filter(
        (field) => !(field in sent) || note[field] !== sent[field],
      );
    });
  }

  /**
   * Creates the note on the server, or sends edits it has not confirmed.
   * Bodies are built when the request is sent, so a wait for the connection
   * never sends stale text.
   */
  private async pushNote(noteId: string): Promise<void> {
    const note = this.assertOwned(noteId);
    const cloud = note.cloud!;
    if (note.source === "import" && !cloud.onServer) {
      return;
    }
    if (cloud.onServer && cloud.unsyncedFields.length === 0) {
      return;
    }
    const { api } = this.deps;
    let sent: Partial<Pick<Note, "title" | "personalNotes">> = {};
    if (cloud.onServer) {
      try {
        const server = await this.request(noteId, () => {
          const latest = this.assertOwned(noteId);
          const unsynced = latest.cloud!.unsyncedFields;
          sent = {
            ...(unsynced.includes("title") ? { title: latest.title } : {}),
            ...(unsynced.includes("personalNotes")
              ? { personalNotes: latest.personalNotes }
              : {}),
          };
          return api.patchNote(noteId, sent);
        });
        await this.confirmServerNote(noteId, server, sent);
        return;
      } catch (error) {
        if (
          !(error instanceof NotesApiError && error.code === "note_not_found")
        ) {
          throw error;
        }
      }
    }
    const server = await this.request(noteId, () => {
      const latest = this.assertOwned(noteId);
      sent = { title: latest.title, personalNotes: latest.personalNotes };
      return api.putNote(noteId, {
        title: latest.title,
        titleSource: latest.titleSource === "user" ? "user" : "default",
        personalNotes: latest.personalNotes,
        createdAt: latest.createdAt,
      });
    });
    await this.confirmServerNote(noteId, server, sent);
  }

  private async sendImport(noteId: string): Promise<void> {
    const note = this.assertOwned(noteId);
    const transcript =
      this.deps.store
        .getSegments(noteId)
        .find((segment) => segment.kind === "import")?.transcript?.text ?? "";
    const server = await this.request(noteId, () =>
      this.deps.api.importNote({
        id: noteId,
        transcript,
        ...(note.titleSource === "user" ? { title: note.title } : {}),
        createdAt: note.createdAt,
      }),
    );
    await this.confirmServerNote(noteId, server, {});
    await this.deps.store.updateNote(noteId, (draft) => {
      draft.status = transitionNote(draft.status, "start-processing");
      this.markProcessRequested(draft);
    });
  }

  private segmentsToUpload(noteId: string): NoteSegment[] {
    return this.deps.store
      .getSegments(noteId)
      .filter(
        (segment) =>
          segment.kind === "audio" &&
          segment.status !== "recording" &&
          segment.status !== "transcribed" &&
          segment.audioPath !== null &&
          !segment.upload?.complete,
      );
  }

  private async uploadSegments(noteId: string): Promise<void> {
    for (const segment of this.deps.store.getSegments(noteId)) {
      if (segmentNeedsReupload(segment) && segment.audioPath) {
        await this.deps.store.updateSegment(noteId, segment.id, (draft) => {
          draft.upload = null;
        });
      }
    }
    for (const segment of this.segmentsToUpload(noteId)) {
      await this.uploadSegment(noteId, segment.id);
    }
  }

  private async uploadSegment(
    noteId: string,
    segmentId: string,
  ): Promise<void> {
    const { store, api, audio } = this.deps;
    const current = () =>
      store.getSegments(noteId).find((segment) => segment.id === segmentId);

    for (let sessions = 0; sessions < MAX_UPLOAD_SESSIONS; ) {
      const segment = current();
      if (!segment?.audioPath) {
        throw new NoteUnavailableError();
      }
      const audioPath = segment.audioPath;
      const sizeBytes = await audio.getFileSize(audioPath);
      let upload = segment.upload;
      if (!upload || upload.sizeBytes !== sizeBytes) {
        sessions++;
        let url: string;
        try {
          url = await this.request(noteId, () =>
            api.requestSegmentUpload(noteId, segmentId, {
              durationMs: segment.durationMs,
              sizeBytes,
              index: segment.index,
            }),
          );
        } catch (error) {
          // Transcribed, or accepted by a running job: nothing to upload.
          if (
            error instanceof NotesApiError &&
            (error.code === "segment_transcribed" ||
              error.code === "segment_processing")
          ) {
            await store.updateSegment(noteId, segmentId, (draft) => {
              draft.upload = { url: "", sizeBytes, complete: true };
            });
            return;
          }
          throw error;
        }
        upload = { url, sizeBytes, complete: false };
        const started = upload;
        await store.updateSegment(noteId, segmentId, (draft) => {
          draft.upload = started;
          draft.status = "uploading";
          draft.error = null;
        });
      }

      let interruptions = 0;
      for (;;) {
        this.assertOwned(noteId);
        if (!this.deps.connectivity.isOnline()) {
          this.deps.setActivity(noteId, { kind: "waiting-for-connection" });
          await this.deps.connectivity.waitUntilOnline();
        }
        await this.deps.yieldToDictation();
        this.assertOwned(noteId);
        this.deps.setActivity(noteId, {
          kind: "uploading",
          segmentId,
          uploadedBytes: 0,
          totalBytes: sizeBytes,
        });
        const result = await audio.uploadResumable({
          uploadId: segmentId,
          filePath: audioPath,
          url: upload.url,
          contentType: NOTE_AUDIO_CONTENT_TYPE,
          maxBytes: UPLOAD_PASS_BYTES,
        });
        if (result.outcome === "partial") {
          interruptions = 0;
          continue;
        }
        if (result.outcome === "complete") {
          await store.updateSegment(noteId, segmentId, (draft) => {
            if (draft.upload) draft.upload.complete = true;
          });
          return;
        }
        if (result.outcome === "cancelled") {
          throw new NoteUnavailableError();
        }
        if (result.outcome === "expired") {
          await store.updateSegment(noteId, segmentId, (draft) => {
            draft.upload = null;
          });
          break;
        }
        if (result.outcome === "rejected" && result.status === 400) {
          // Storage refused the byte count: start over with a fresh session.
          await store.updateSegment(noteId, segmentId, (draft) => {
            draft.upload = null;
          });
          break;
        }
        if (result.outcome === "rejected") {
          throw new NoteBlockedError(
            "upload_rejected",
            `The upload was refused (${result.status ?? "unknown"})`,
          );
        }
        const serverSide = result.status !== null && result.status !== 308;
        if (serverSide && ++interruptions > MAX_SERVER_RETRIES) {
          throw new NoteBlockedError(
            "upload_failed",
            `The upload kept failing (${result.status})`,
          );
        }
        this.deps.setActivity(noteId, { kind: "waiting-for-connection" });
        await this.deps.sleep(backoffMs(interruptions));
      }
    }
    throw new NoteBlockedError(
      "upload_failed",
      "The upload session kept expiring",
    );
  }

  /** `POST /process`, re-uploading whatever the server reports missing. */
  private async requestProcessing(noteId: string): Promise<void> {
    for (let round = 0; ; round++) {
      const note = this.assertOwned(noteId);
      const body = {
        personalNotes: note.personalNotes,
        ...(note.titleSource === "user" ? { title: note.title } : {}),
      };
      try {
        const server = await this.request(noteId, () =>
          this.deps.api.processNote(noteId, body),
        );
        await this.confirmServerNote(noteId, server, body);
        await this.deps.store.updateNote(noteId, (draft) => {
          if (draft.status === "pending") {
            draft.status = transitionNote(draft.status, "start-processing");
          }
          this.markProcessRequested(draft);
        });
        return;
      } catch (error) {
        if (
          !(error instanceof NotesApiError && error.code === "audio_missing") ||
          round >= MAX_AUDIO_MISSING_ROUNDS
        ) {
          throw error;
        }
        const reupload = this.deps.store
          .getSegments(noteId)
          .filter(
            (segment) =>
              error.segmentIds.includes(segment.id) &&
              segment.audioPath !== null,
          );
        if (reupload.length === 0) {
          throw error;
        }
        for (const segment of reupload) {
          await this.deps.store.updateSegment(noteId, segment.id, (draft) => {
            draft.upload = null;
          });
          await this.uploadSegment(noteId, segment.id);
        }
      }
    }
  }

  /** Polls until the server settles, asking it to pick up a stale job. */
  private async settle(noteId: string): Promise<void> {
    const started = this.deps.now();
    for (;;) {
      this.deps.setActivity(noteId, { kind: "processing" });
      const server = await this.request(noteId, () =>
        this.deps.api.getNote(noteId),
      );
      await this.applyServerNote(noteId, server);
      if (server.status === "ready" || server.status === "failed") {
        await this.releaseTranscribedAudio(noteId, server);
        return;
      }
      const requestedAt =
        this.deps.store.getNote(noteId)?.cloud?.processRequestedAt;
      if (
        server.status === "draft" ||
        (requestedAt &&
          this.deps.now() - dayjs(requestedAt).valueOf() >
            NOTE_PROCESSING_STALE_MS)
      ) {
        await this.requestProcessing(noteId);
      }
      await this.deps.sleep(
        this.deps.now() - started < NOTE_SLOW_POLL_AFTER_MS
          ? NOTE_POLL_INTERVAL_MS
          : NOTE_SLOW_POLL_INTERVAL_MS,
      );
    }
  }

  private async applyServerNote(
    noteId: string,
    server: ServerNoteWithSegments,
  ): Promise<void> {
    const { store } = this.deps;
    const local = store.getNote(noteId);
    const ownerUserId = local?.cloud?.ownerUserId;
    if (!local || !ownerUserId) {
      throw new NoteUnavailableError();
    }
    const merged = mergeServerNote(local, server, ownerUserId);
    merged.cloud!.fetchedUpdatedAt = server.updatedAt;
    const segments = mergeServerSegments(
      noteId,
      store.getSegments(noteId),
      server.segments,
    );
    for (const segment of segments) {
      await store.putSegment(segment);
    }
    merged.durationMs = Math.max(
      merged.durationMs,
      segments.reduce((total, segment) => total + segment.durationMs, 0),
    );
    await store.putNote(merged);
  }

  /**
   * Local audio goes only once the server reports the note `ready` and the
   * segment `transcribed`, after that result is stored here.
   */
  private async releaseTranscribedAudio(
    noteId: string,
    server: ServerNoteWithSegments,
  ): Promise<void> {
    if (server.status !== "ready") {
      return;
    }
    const transcribed = new Set(
      server.segments
        .filter((segment) => segment.status === "transcribed")
        .map((segment) => segment.id),
    );
    for (const segment of this.deps.store.getSegments(noteId)) {
      if (!segment.audioPath || !transcribed.has(segment.id)) {
        continue;
      }
      try {
        await this.deps.audio.deleteSegmentAudio(segment.audioPath);
        await this.deps.store.updateSegment(noteId, segment.id, (draft) => {
          draft.audioPath = null;
          draft.upload = null;
        });
      } catch (error) {
        getLogger().warning(`Failed to delete meeting audio: ${error}`);
      }
    }
  }
}
