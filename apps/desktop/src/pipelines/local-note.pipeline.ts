import type {
  LlmChatInput,
  LlmStreamEvent,
  Note,
  NoteError,
  NoteSegment,
} from "@voquill/types";
import dayjs from "dayjs";
import type { BaseNoteRepo } from "../repos/note.repo";
import type { MeetingAudioRepo } from "../repos/meeting-audio.repo";
import { MEETING_AUDIO_SAMPLE_RATE } from "../repos/meeting-audio.repo";
import { getLogger } from "../utils/log.utils";
import {
  appendChunkTranscript,
  buildNoteTranscriptText,
  isNoteAudioChunkSilent,
  NOTE_ENVELOPE_WINDOW_MS,
  planNoteAudioChunks,
} from "../utils/note-audio.utils";
import {
  buildAskMessages,
  EMPTY_TRANSCRIPT_NOTES,
  formatNoteTranscriptForModel,
  generateNoteContent,
  type NoteGenerationModel,
  type NoteTextGenerator,
} from "../utils/note-prompt.utils";
import {
  extractQuestionTerms,
  extractSearchTerms,
  getAskSources,
  rankNoteSearchResults,
  selectAskPassages,
  type NoteSearchDocument,
  type NoteSearchResult,
} from "../utils/note-search.utils";
import { transitionNote } from "../utils/note-state.utils";
import {
  BaseNotePipeline,
  type NoteAskEvent,
  type NoteAskInput,
  type NoteImportInput,
} from "./base-note.pipeline";

/** The app's note state; writes resolve once they are durable in SQLite. */
export type NoteStore = {
  getNote(noteId: string): Note | null;
  /** Newest first. */
  getNotes(): Note[];
  getSegments(noteId: string): NoteSegment[];
  loadSegments(noteId: string): Promise<NoteSegment[]>;
  insertNote(note: Note, segments: NoteSegment[]): Promise<void>;
  /** Replaces a note's fields (keeps its segments). */
  putNote(note: Note): Promise<void>;
  /** Adds or replaces one segment of a note whose segments are loaded. */
  putSegment(segment: NoteSegment): Promise<void>;
  removeSegment(noteId: string, segmentId: string): Promise<void>;
  updateNote(noteId: string, recipe: (note: Note) => void): Promise<void>;
  updateSegment(
    noteId: string,
    segmentId: string,
    recipe: (segment: NoteSegment) => void,
  ): Promise<void>;
  /** Removes the note, its segments and its local audio. */
  deleteNote(noteId: string): Promise<void>;
};

export type NoteChatGenerator = NoteTextGenerator & {
  streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent>;
};

export type LocalNotePipelineDeps = {
  store: NoteStore;
  repo: Pick<BaseNoteRepo, "searchNotes">;
  audio: Pick<
    MeetingAudioRepo,
    "getEnvelope" | "readSamples" | "deleteSegmentAudio"
  >;
  /** Transcribes with the user's transcription mode, dictionary and language. */
  transcribe(input: {
    samples: Float32Array;
    sampleRate: number;
  }): Promise<string>;
  /** The user's post-processing model, or null when post-processing is off. */
  getGenerationModel(): NoteGenerationModel | null;
  getChatGenerator(): NoteChatGenerator | null;
  /** Whose cloud notes (local copies) search may include. */
  getCloudNotesUserId(): string | null;
};

export type NoteErrorCode =
  | "audio_missing"
  | "transcription_failed"
  | "generation_failed";

export class NoteProcessingError extends Error {
  readonly code: NoteErrorCode;

  constructor(code: NoteErrorCode, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.code = code;
  }
}

class NoteDeletedError extends Error {}

const SEARCH_LIMIT = 50;
const ASK_CANDIDATE_LIMIT = 12;
const ASK_FALLBACK_NOTE_COUNT = 5;
const ASK_CONTEXT_CHARS = 16_000;

const toNoteError = (error: unknown): NoteError => {
  if (error instanceof NoteProcessingError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "unknown",
    message: error instanceof Error ? error.message : String(error),
  };
};

const toDocument = (
  note: Note,
  segments: NoteSegment[],
): NoteSearchDocument => ({
  note,
  transcript: buildNoteTranscriptText(segments),
});

/** Text search over the notes stored on this device. */
export const searchLocalNotes = async (
  repo: Pick<BaseNoteRepo, "searchNotes">,
  query: string,
  cloudOwnerUserId: string | null,
): Promise<NoteSearchResult[]> => {
  const terms = extractSearchTerms(query);
  if (terms.length === 0) {
    return [];
  }
  const candidates = await repo.searchNotes({
    terms,
    matchAll: true,
    limit: SEARCH_LIMIT,
    cloudOwnerUserId,
  });
  return rankNoteSearchResults(candidates, terms);
};

export class LocalNotePipeline extends BaseNotePipeline {
  private readonly deps: LocalNotePipelineDeps;
  private readonly runningNoteIds = new Set<string>();

  constructor(deps: LocalNotePipelineDeps) {
    super();
    this.deps = deps;
  }

  async process(noteId: string): Promise<void> {
    const { store } = this.deps;
    if (
      this.runningNoteIds.has(noteId) ||
      store.getNote(noteId)?.status !== "pending"
    ) {
      return;
    }

    this.runningNoteIds.add(noteId);
    try {
      await store.loadSegments(noteId);
      await store.updateNote(noteId, (note) => {
        note.status = transitionNote(note.status, "start-processing");
        note.error = null;
      });
      await this.transcribeSegments(noteId);
      await this.generate(noteId);
      await store.updateNote(noteId, (note) => {
        note.status = transitionNote(note.status, "succeed");
      });
      await this.releaseTranscribedAudio(noteId);
    } catch (error) {
      if (error instanceof NoteDeletedError || !store.getNote(noteId)) {
        return;
      }
      const noteError = toNoteError(error);
      getLogger().error(`Note processing failed (${noteError.code})`);
      await store.updateNote(noteId, (note) => {
        note.status = transitionNote(note.status, "fail");
        note.error = noteError;
      });
    } finally {
      this.runningNoteIds.delete(noteId);
    }
  }

  async regenerate(noteId: string): Promise<void> {
    const note = this.deps.store.getNote(noteId);
    if (note?.status !== "ready" || this.runningNoteIds.has(noteId)) {
      return;
    }
    await this.deps.store.updateNote(noteId, (draft) => {
      draft.status = transitionNote(draft.status, "regenerate");
    });
    await this.process(noteId);
  }

  async saveEdits(): Promise<void> {}

  async refresh(noteId: string): Promise<void> {
    await this.deps.store.loadSegments(noteId);
  }

  async resumeAfterRestart(noteId: string): Promise<void> {
    const note = this.deps.store.getNote(noteId);
    if (note?.status === "pending") {
      await this.process(noteId);
    } else if (note?.status === "ready" && note.source === "recording") {
      await this.deps.store.loadSegments(noteId);
      await this.releaseTranscribedAudio(noteId);
    }
  }

  async importTranscript({
    id,
    transcript,
    title,
    defaultTitle,
  }: NoteImportInput): Promise<void> {
    const now = dayjs().toISOString();
    const text = transcript.trim();
    const userTitle = title?.trim() ?? "";
    await this.deps.store.insertNote(
      {
        id,
        storage: "local",
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
        cloud: null,
      },
      [
        {
          id: `${id}-import`,
          noteId: id,
          index: 0,
          kind: "import",
          status: "transcribed",
          durationMs: 0,
          createdAt: now,
          transcript: { text, utterances: [] },
          transcribedMs: 0,
          audioPath: null,
          error: null,
          upload: null,
        },
      ],
    );
    await this.process(id);
  }

  async deleteNote(noteId: string): Promise<void> {
    await this.deps.store.deleteNote(noteId);
  }

  async search(query: string): Promise<NoteSearchResult[]> {
    return searchLocalNotes(
      this.deps.repo,
      query,
      this.deps.getCloudNotesUserId(),
    );
  }

  async *ask({
    question,
    noteId,
    history,
  }: NoteAskInput): AsyncGenerator<NoteAskEvent> {
    const generator = this.deps.getChatGenerator();
    if (!generator) {
      yield { type: "error", message: "post_processing_disabled" };
      return;
    }

    const previousQuestion = [...history]
      .reverse()
      .find((message) => message.role === "user")?.content;
    const terms = extractQuestionTerms(
      [question, previousQuestion ?? ""].join(" "),
    );
    const documents = await this.getAskDocuments(noteId, terms);
    const passages = selectAskPassages({
      documents,
      terms,
      maxChars: ASK_CONTEXT_CHARS,
    });
    const sources = getAskSources(passages);
    yield { type: "sources", sources };

    const messages = buildAskMessages({
      question,
      passages,
      sourceNoteIds: sources.map((source) => source.noteId),
      history,
    });

    let answer = "";
    try {
      for await (const event of generator.streamChat({ messages })) {
        if (event.type === "text-delta") {
          answer += event.text;
          yield { type: "delta", text: event.text };
        } else if (event.type === "error") {
          yield { type: "error", message: event.error };
          return;
        }
      }
    } catch (error) {
      yield {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      };
      return;
    }
    yield { type: "done", answer, sources };
  }

  private async getAskDocuments(
    noteId: string | null,
    terms: string[],
  ): Promise<NoteSearchDocument[]> {
    const { store, repo } = this.deps;
    if (noteId) {
      const note = store.getNote(noteId);
      if (!note) {
        return [];
      }
      return [toDocument(note, await store.loadSegments(noteId))];
    }

    const candidates =
      terms.length > 0
        ? await repo.searchNotes({
            terms,
            matchAll: false,
            limit: ASK_CANDIDATE_LIMIT,
            cloudOwnerUserId: this.deps.getCloudNotesUserId(),
          })
        : [];
    if (candidates.length > 0) {
      return rankNoteSearchResults(candidates, terms).map(
        (result) =>
          candidates.find((candidate) => candidate.note.id === result.note.id)!,
      );
    }

    const recent = store
      .getNotes()
      .filter((note) => note.status === "ready")
      .slice(0, ASK_FALLBACK_NOTE_COUNT);
    return Promise.all(
      recent.map(async (note) =>
        toDocument(note, await store.loadSegments(note.id)),
      ),
    );
  }

  private assertNoteExists(noteId: string) {
    if (!this.deps.store.getNote(noteId)) {
      throw new NoteDeletedError();
    }
  }

  private async transcribeSegments(noteId: string): Promise<void> {
    const { store, audio } = this.deps;
    for (const segment of store.getSegments(noteId)) {
      if (segment.status === "transcribed") {
        continue;
      }
      if (!segment.audioPath) {
        throw new NoteProcessingError(
          "audio_missing",
          "The recording for this note is missing",
        );
      }

      try {
        const envelope = await audio.getEnvelope(
          segment.audioPath,
          NOTE_ENVELOPE_WINDOW_MS,
        );
        const chunks = planNoteAudioChunks({
          envelope,
          windowMs: NOTE_ENVELOPE_WINDOW_MS,
          fromMs: segment.transcribedMs,
          durationMs: segment.durationMs,
        });

        for (const chunk of chunks) {
          const silent = isNoteAudioChunkSilent({
            envelope,
            windowMs: NOTE_ENVELOPE_WINDOW_MS,
            chunk,
          });
          const text = silent
            ? ""
            : await this.deps.transcribe({
                samples: await audio.readSamples(
                  segment.audioPath,
                  chunk.startMs,
                  chunk.endMs,
                ),
                sampleRate: MEETING_AUDIO_SAMPLE_RATE,
              });
          this.assertNoteExists(noteId);
          await store.updateSegment(noteId, segment.id, (draft) => {
            draft.transcript = appendChunkTranscript(
              draft.transcript,
              chunk,
              text,
            );
            draft.transcribedMs = chunk.endMs;
          });
        }
      } catch (error) {
        if (error instanceof NoteDeletedError) {
          throw error;
        }
        throw new NoteProcessingError("transcription_failed", error);
      }

      await store.updateSegment(noteId, segment.id, (draft) => {
        draft.status = "transcribed";
        draft.transcribedMs = draft.durationMs;
        draft.transcript ??= { text: "", utterances: [] };
      });
    }
  }

  private async generate(noteId: string): Promise<void> {
    const { store } = this.deps;
    const transcript = formatNoteTranscriptForModel(store.getSegments(noteId));
    const model = transcript.trim() ? this.deps.getGenerationModel() : null;
    if (!model) {
      await store.updateNote(noteId, (note) => {
        note.generatedNotes = transcript.trim() ? null : EMPTY_TRANSCRIPT_NOTES;
      });
      return;
    }

    try {
      const note = store.getNote(noteId);
      const content = await generateNoteContent(model, {
        transcript,
        personalNotes: note?.personalNotes ?? "",
        wantTitle: note?.titleSource !== "user",
        meetingDate: note?.createdAt.slice(0, 10) ?? "",
      });
      this.assertNoteExists(noteId);
      await store.updateNote(noteId, (draft) => {
        draft.generatedNotes = content.notes;
        if (content.title && draft.titleSource !== "user") {
          draft.title = content.title;
          draft.titleSource = "ai";
        }
      });
    } catch (error) {
      if (error instanceof NoteDeletedError) {
        throw error;
      }
      throw new NoteProcessingError("generation_failed", error);
    }
  }

  /** Runs only once the note is ready, after every transcript is committed. */
  private async releaseTranscribedAudio(noteId: string): Promise<void> {
    const { store, audio } = this.deps;
    for (const segment of store.getSegments(noteId)) {
      if (segment.status !== "transcribed" || !segment.audioPath) {
        continue;
      }
      try {
        await audio.deleteSegmentAudio(segment.audioPath);
        await store.updateSegment(noteId, segment.id, (draft) => {
          draft.audioPath = null;
        });
      } catch (error) {
        getLogger().warning(`Failed to delete meeting audio: ${error}`);
      }
    }
  }
}
