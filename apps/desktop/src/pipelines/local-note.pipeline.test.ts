import type {
  LlmChatInput,
  LlmStreamEvent,
  Note,
  NoteSegment,
} from "@voquill/types";
import { describe, expect, it, vi } from "vitest";
import type { GenerateTextInput } from "../repos/generate-text.repo";
import type { NoteSearchCandidate } from "../repos/note.repo";
import {
  DEFAULT_NOTE_CHUNK_LIMITS,
  LOCAL_WHISPER_NOTE_CHUNK_LIMITS,
  NOTE_CHUNK_MAX_MS,
} from "../utils/note-audio.utils";
import { EMPTY_TRANSCRIPT_NOTES } from "../utils/note-prompt.utils";
import type { NoteAskEvent } from "./base-note.pipeline";
import { FakeNoteStore } from "./fake-note-store.test-utils";
import {
  DICTATION_WORDS_EXCEEDED_ERROR_CODE,
  LocalNotePipeline,
  NoteProcessingError,
  type NoteChatGenerator,
} from "./local-note.pipeline";

const PROCESSED_ON_DEVICE = {
  transcription: { kind: "device" as const },
  notes: { kind: "device" as const },
};
let wordBudget: number | null = null;

vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    info: () => {},
    warning: () => {},
    error: () => {},
    verbose: () => {},
  }),
}));

const GENERATED_NOTES =
  "The team planned the launch.\n\n## Decisions\n- Ship in May";

const NOW = "2026-05-01T12:00:00.000Z";

const makeNote = (overrides: Partial<Note> = {}): Note => ({
  id: "note",
  storage: "local",
  status: "pending",
  title: "Meeting, May 1",
  titleSource: "default",
  error: null,
  source: "recording",
  personalNotes: "",
  generatedNotes: null,
  durationMs: 0,
  createdAt: NOW,
  updatedAt: NOW,
  processedWith: null,
  cloud: null,
  ...overrides,
});

const audioSegment = (
  index: number,
  durationMs: number,
  overrides: Partial<NoteSegment> = {},
): NoteSegment => ({
  id: `seg-${index}`,
  noteId: "note",
  index,
  kind: "audio",
  status: "recorded",
  durationMs,
  createdAt: NOW,
  transcript: null,
  transcribedMs: 0,
  audioPath: `/audio/seg-${index}.wav`,
  error: null,
  upload: null,
  ...overrides,
});

type Harness = {
  store: FakeNoteStore;
  pipeline: LocalNotePipeline;
  transcribeCalls: number[];
  prompts: string[];
  deleted: string[];
  setTranscribeFailure: (failAtCall: number | null, error?: Error) => void;
  setGenerator: (enabled: boolean) => void;
};

const createHarness = ({
  note = makeNote(),
  segments = [audioSegment(0, 10_000)],
  searchResults = [] as NoteSearchCandidate[],
  chatEvents = [] as LlmStreamEvent[],
} = {}): Harness => {
  const store = new FakeNoteStore();
  store.notes.set(note.id, structuredClone(note));
  store.segments.set(note.id, structuredClone(segments));

  const transcribeCalls: number[] = [];
  const prompts: string[] = [];
  const deleted: string[] = [];
  let failAtCall: number | null = null;
  let failure: Error = new Error("network down");
  let generatorEnabled = true;

  const generator: NoteChatGenerator = {
    async generateText(input: GenerateTextInput) {
      prompts.push(`${input.system ?? ""}\n${input.prompt}`);
      const wantsTitle = input.system?.includes('"title"') ?? false;
      return {
        text: JSON.stringify({
          ...(wantsTitle ? { title: "Launch plan" } : {}),
          notes: GENERATED_NOTES,
        }),
      };
    },
    async *streamChat(input: LlmChatInput) {
      prompts.push(JSON.stringify(input.messages));
      yield* chatEvents;
    },
  };

  const pipeline = new LocalNotePipeline({
    store,
    repo: { searchNotes: async () => searchResults },
    audio: {
      getEnvelope: async () => Array.from({ length: 100_000 }, () => 0.1),
      readSamples: async (_path, startMs, endMs) =>
        new Float32Array(Math.round(((endMs - startMs) / 1000) * 16_000)),
      deleteSegmentAudio: async (path) => {
        deleted.push(path);
        store.log.push(`delete-audio:${path}`);
      },
    },
    transcribe: async ({ samples }) => {
      transcribeCalls.push(samples.length);
      if (failAtCall !== null && transcribeCalls.length === failAtCall) {
        throw failure;
      }
      return `chunk ${transcribeCalls.length}`;
    },
    getGenerationModel: () =>
      generatorEnabled ? { generator, contextTokens: 32_768 } : null,
    getChatGenerator: () => (generatorEnabled ? generator : null),
    getCloudNotesUserId: () => null,
    getChunkLimits: () => DEFAULT_NOTE_CHUNK_LIMITS,
    getProcessedWith: () => PROCESSED_ON_DEVICE,
    getTranscriptionWordBudget: () => wordBudget,
    yieldToDictation: async () => {},
  });

  return {
    store,
    pipeline,
    transcribeCalls,
    prompts,
    deleted,
    setTranscribeFailure: (value, error) => {
      failAtCall = value;
      if (error) failure = error;
    },
    setGenerator: (enabled) => {
      generatorEnabled = enabled;
    },
  };
};

describe("LocalNotePipeline.process", () => {
  it("transcribes, generates and only then releases the audio", async () => {
    const harness = createHarness({
      note: makeNote({ personalNotes: "ask about pricing" }),
    });
    await harness.pipeline.process("note");

    const note = harness.store.getNote("note")!;
    expect(note.status).toBe("ready");
    expect(note.title).toBe("Launch plan");
    expect(note.titleSource).toBe("ai");
    expect(note.generatedNotes).toBe(GENERATED_NOTES);
    expect(note.personalNotes).toBe("ask about pricing");
    expect(harness.prompts[0]).toContain("ask about pricing");

    const [segment] = harness.store.getSegments("note");
    expect(segment.status).toBe("transcribed");
    expect(segment.transcript?.text).toBe("chunk 1");
    expect(segment.audioPath).toBeNull();

    const log = harness.store.log;
    const committed = log.indexOf("segment:seg-0:transcribed:10000");
    const ready = log.indexOf("note:ready");
    const deletedAt = log.indexOf("delete-audio:/audio/seg-0.wav");
    expect(committed).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(committed);
    expect(deletedAt).toBeGreaterThan(ready);
  });

  it("keeps a user-chosen title", async () => {
    const harness = createHarness({
      note: makeNote({ title: "Board call", titleSource: "user" }),
    });
    await harness.pipeline.process("note");
    expect(harness.store.getNote("note")?.title).toBe("Board call");
    expect(
      harness.prompts.some((prompt) => prompt.includes('"title": string')),
    ).toBe(false);
  });

  it("fails mid-way keeping progress and audio, and the retry resumes", async () => {
    const longMs = NOTE_CHUNK_MAX_MS * 2 + 60_000;
    const harness = createHarness({ segments: [audioSegment(0, longMs)] });
    harness.setTranscribeFailure(2);

    await harness.pipeline.process("note");

    let note = harness.store.getNote("note")!;
    expect(note.status).toBe("failed");
    expect(note.error).toEqual({
      code: "transcription_failed",
      message: "network down",
    });
    let [segment] = harness.store.getSegments("note");
    expect(segment.status).toBe("recorded");
    expect(segment.transcript?.utterances).toHaveLength(1);
    const committedMs = segment.transcribedMs;
    expect(committedMs).toBeGreaterThan(0);
    expect(segment.audioPath).toBe("/audio/seg-0.wav");
    expect(harness.deleted).toEqual([]);

    harness.setTranscribeFailure(null);
    await harness.store.updateNote("note", (draft) => {
      draft.status = "pending";
    });
    const callsBeforeRetry = harness.transcribeCalls.length;
    await harness.pipeline.process("note");

    note = harness.store.getNote("note")!;
    expect(note.status).toBe("ready");
    expect(note.error).toBeNull();
    [segment] = harness.store.getSegments("note");
    expect(segment.transcript?.utterances[0].endMs).toBe(committedMs);
    expect(segment.transcript?.utterances[1].startMs).toBe(committedMs);
    expect(segment.transcript?.utterances.at(-1)?.endMs).toBe(longMs);
    const retriedSamples = harness.transcribeCalls
      .slice(callsBeforeRetry)
      .reduce((sum, count) => sum + count, 0);
    expect(retriedSamples).toBe(((longMs - committedMs) / 1000) * 16_000);
    expect(harness.deleted).toEqual(["/audio/seg-0.wav"]);
  });

  it("records a generation failure and never deletes the audio", async () => {
    const harness = createHarness();
    harness.pipeline = new LocalNotePipeline({
      store: harness.store,
      repo: { searchNotes: async () => [] },
      audio: {
        getEnvelope: async () => [0.1],
        readSamples: async () => new Float32Array(16),
        deleteSegmentAudio: async (path) => {
          harness.deleted.push(path);
        },
      },
      transcribe: async () => "hello",
      getGenerationModel: () => ({
        generator: {
          generateText: async () => {
            throw new Error("model unavailable");
          },
        },
        contextTokens: 32_768,
      }),
      getChatGenerator: () => null,
      getCloudNotesUserId: () => null,
      getChunkLimits: () => DEFAULT_NOTE_CHUNK_LIMITS,
      getProcessedWith: () => PROCESSED_ON_DEVICE,
      getTranscriptionWordBudget: () => wordBudget,
      yieldToDictation: async () => {},
    });
    await harness.pipeline.process("note");

    const note = harness.store.getNote("note")!;
    expect(note.status).toBe("failed");
    expect(note.error?.code).toBe("generation_failed");
    expect(harness.store.getSegments("note")[0].status).toBe("transcribed");
    expect(harness.deleted).toEqual([]);
  });

  it("ends ready with the transcript only when post-processing is off", async () => {
    const harness = createHarness();
    harness.setGenerator(false);
    await harness.pipeline.process("note");

    const note = harness.store.getNote("note")!;
    expect(note.status).toBe("ready");
    expect(note.generatedNotes).toBeNull();
    expect(note.title).toBe("Meeting, May 1");
    expect(note.titleSource).toBe("default");
    expect(harness.store.getSegments("note")[0].transcript?.text).toBe(
      "chunk 1",
    );
    expect(harness.deleted).toEqual(["/audio/seg-0.wav"]);
  });

  it("ends ready for a recording without speech", async () => {
    const harness = createHarness({ segments: [audioSegment(0, 5_000)] });
    harness.pipeline = new LocalNotePipeline({
      store: harness.store,
      repo: { searchNotes: async () => [] },
      audio: {
        getEnvelope: async () => Array.from({ length: 50 }, () => 0),
        readSamples: async () => new Float32Array(0),
        deleteSegmentAudio: async () => {},
      },
      transcribe: async () => {
        throw new Error("silence must not be sent");
      },
      getGenerationModel: () => {
        throw new Error("nothing to generate from");
      },
      getChatGenerator: () => null,
      getCloudNotesUserId: () => null,
      getChunkLimits: () => DEFAULT_NOTE_CHUNK_LIMITS,
      getProcessedWith: () => PROCESSED_ON_DEVICE,
      getTranscriptionWordBudget: () => wordBudget,
      yieldToDictation: async () => {},
    });
    await harness.pipeline.process("note");

    const note = harness.store.getNote("note")!;
    expect(note.status).toBe("ready");
    expect(note.generatedNotes).toBe(EMPTY_TRANSCRIPT_NOTES);
    expect(harness.store.getSegments("note")[0].transcript).toEqual({
      text: "",
      utterances: [],
    });
  });

  it("does nothing for notes that are not pending", async () => {
    const harness = createHarness({ note: makeNote({ status: "paused" }) });
    await harness.pipeline.process("note");
    expect(harness.store.getNote("note")?.status).toBe("paused");
    expect(harness.transcribeCalls).toEqual([]);
  });

  it("stops quietly when the note is deleted while processing", async () => {
    const harness = createHarness();
    harness.pipeline = new LocalNotePipeline({
      store: harness.store,
      repo: { searchNotes: async () => [] },
      audio: {
        getEnvelope: async () => [0.1],
        readSamples: async () => new Float32Array(16),
        deleteSegmentAudio: async () => {},
      },
      transcribe: async () => {
        await harness.store.deleteNote("note");
        return "late";
      },
      getGenerationModel: () => null,
      getChatGenerator: () => null,
      getCloudNotesUserId: () => null,
      getChunkLimits: () => DEFAULT_NOTE_CHUNK_LIMITS,
      getProcessedWith: () => PROCESSED_ON_DEVICE,
      getTranscriptionWordBudget: () => wordBudget,
      yieldToDictation: async () => {},
    });
    await harness.pipeline.process("note");
    expect(harness.store.getNote("note")).toBeNull();
    expect(harness.store.log).toEqual(["note:processing", "delete-note:note"]);
  });
});

describe("LocalNotePipeline resume and regenerate", () => {
  it("transcribes only the new segment and regenerates from everything", async () => {
    const harness = createHarness({
      note: makeNote({
        status: "pending",
        title: "Launch plan",
        titleSource: "ai",
        generatedNotes: "old notes",
      }),
      segments: [
        audioSegment(0, 10_000, {
          status: "transcribed",
          transcribedMs: 10_000,
          audioPath: null,
          transcript: { text: "earlier talk", utterances: [] },
        }),
        audioSegment(1, 4_000),
      ],
    });
    await harness.pipeline.process("note");

    expect(harness.transcribeCalls).toEqual([64_000]);
    const notesPrompt = harness.prompts[0];
    expect(notesPrompt).toContain(
      "--- Recording part 1 ---\nearlier talk\n\n--- Recording part 2 ---\n[00:00] Speaker: chunk 1",
    );
    expect(harness.store.getNote("note")?.generatedNotes).toBe(GENERATED_NOTES);
    expect(harness.deleted).toEqual(["/audio/seg-1.wav"]);
  });

  it("regenerates a ready note without transcribing again", async () => {
    const harness = createHarness({
      note: makeNote({ status: "ready", generatedNotes: "old" }),
      segments: [
        audioSegment(0, 10_000, {
          status: "transcribed",
          transcribedMs: 10_000,
          audioPath: null,
          transcript: { text: "the talk", utterances: [] },
        }),
      ],
    });
    await harness.pipeline.regenerate("note");

    expect(harness.transcribeCalls).toEqual([]);
    expect(harness.store.log.slice(0, 3)).toEqual([
      "note:pending",
      "note:processing",
      "note:ready",
    ]);
    expect(harness.store.getNote("note")?.generatedNotes).toBe(GENERATED_NOTES);
  });

  it("releases audio left behind by a crash after the note was ready", async () => {
    const harness = createHarness({
      note: makeNote({ status: "ready" }),
      segments: [
        audioSegment(0, 1_000, {
          status: "transcribed",
          transcribedMs: 1_000,
          transcript: { text: "hi", utterances: [] },
        }),
        audioSegment(1, 1_000),
      ],
    });
    await harness.pipeline.resumeAfterRestart("note");
    expect(harness.deleted).toEqual(["/audio/seg-0.wav"]);
  });

  it("re-runs a note left pending by a restart", async () => {
    const harness = createHarness();
    await harness.pipeline.resumeAfterRestart("note");
    expect(harness.store.getNote("note")?.status).toBe("ready");
  });
});

describe("LocalNotePipeline.importTranscript", () => {
  it("creates an import note and generates its notes", async () => {
    const harness = createHarness();
    await harness.pipeline.importTranscript({
      id: "imported",
      transcript: "  pasted words  ",
      title: null,
      defaultTitle: "Imported transcript, May 1",
    });

    const note = harness.store.getNote("imported")!;
    expect(note.source).toBe("import");
    expect(note.status).toBe("ready");
    expect(note.title).toBe("Launch plan");
    expect(harness.store.getSegments("imported")[0]).toMatchObject({
      kind: "import",
      status: "transcribed",
      transcript: { text: "pasted words", utterances: [] },
    });
    expect(harness.transcribeCalls).toEqual([]);
  });

  it("keeps a title given at import", async () => {
    const harness = createHarness();
    await harness.pipeline.importTranscript({
      id: "imported",
      transcript: "words",
      title: "Customer call",
      defaultTitle: "unused",
    });
    expect(harness.store.getNote("imported")).toMatchObject({
      title: "Customer call",
      titleSource: "user",
    });
  });
});

describe("LocalNotePipeline search and ask", () => {
  const candidate = (id: string, title: string, transcript: string) => ({
    note: makeNote({ id, title, status: "ready" }),
    transcript,
  });

  it("requires every search term and ranks with snippets", async () => {
    const harness = createHarness({
      searchResults: [candidate("a", "Budget", "the budget for q3")],
    });
    const results = await harness.pipeline.search("Budget  Q3");
    expect(results).toHaveLength(1);
    expect(results[0].snippet).toBe("the budget for q3");
    expect(await harness.pipeline.search("   ")).toEqual([]);
  });

  it("streams an answer with the cited sources", async () => {
    const harness = createHarness({
      searchResults: [
        candidate("a", "Planning", "the budget is 10k"),
        candidate("b", "Retro", "the budget went over"),
      ],
      chatEvents: [
        { type: "text-delta", text: "It is 10k " },
        { type: "text-delta", text: "[1]." },
        { type: "finish", finishReason: "stop" },
      ],
    });
    const events: NoteAskEvent[] = [];
    for await (const event of harness.pipeline.ask({
      question: "What is the budget?",
      noteId: null,
      history: [],
    })) {
      events.push(event);
    }
    expect(events[0]).toEqual({
      type: "sources",
      sources: [
        { noteId: "a", title: "Planning" },
        { noteId: "b", title: "Retro" },
      ],
    });
    expect(events.at(-1)).toEqual({
      type: "done",
      answer: "It is 10k [1].",
      sources: [
        { noteId: "a", title: "Planning" },
        { noteId: "b", title: "Retro" },
      ],
    });
    const messages = harness.prompts.at(-1)!;
    expect(messages).toContain("the budget is 10k");
    expect(messages).toContain("What is the budget?");
  });

  it("explains that Ask needs post-processing", async () => {
    const harness = createHarness();
    harness.setGenerator(false);
    const events: NoteAskEvent[] = [];
    for await (const event of harness.pipeline.ask({
      question: "anything?",
      noteId: "note",
      history: [],
    })) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "error", message: "post_processing_disabled" },
    ]);
  });
});

describe("LocalNotePipeline and dictation", () => {
  it("waits for a dictation to finish before each chunk and each model call", async () => {
    const events: string[] = [];
    let releaseDictation: () => void = () => {};
    let dictating = true;
    const store = new FakeNoteStore();
    store.notes.set("note", makeNote());
    store.segments.set("note", [audioSegment(0, 70_000)]);
    const pipeline = new LocalNotePipeline({
      store,
      repo: { searchNotes: async () => [] },
      audio: {
        getEnvelope: async () => Array.from({ length: 700 }, () => 0.1),
        readSamples: async () => new Float32Array(16),
        deleteSegmentAudio: async () => {},
      },
      transcribe: async () => {
        events.push("transcribe");
        return "words";
      },
      getGenerationModel: () => ({
        contextTokens: 32_768,
        generator: {
          generateText: async () => {
            events.push("generate");
            return { text: '{"title":"T","notes":"N"}' };
          },
        },
      }),
      getChatGenerator: () => null,
      getCloudNotesUserId: () => null,
      getChunkLimits: () => LOCAL_WHISPER_NOTE_CHUNK_LIMITS,
      getProcessedWith: () => PROCESSED_ON_DEVICE,
      getTranscriptionWordBudget: () => wordBudget,
      yieldToDictation: async () => {
        events.push("yield");
        if (dictating) {
          await new Promise<void>((resolve) => {
            releaseDictation = resolve;
          });
        }
      },
    });

    const run = pipeline.process("note");
    await vi.waitFor(() => expect(events).toEqual(["yield"]));

    dictating = false;
    releaseDictation();
    await run;

    expect(events).toEqual([
      "yield",
      "transcribe",
      "yield",
      "transcribe",
      "yield",
      "transcribe",
      "yield",
      "generate",
    ]);
  });
});

describe("LocalNotePipeline metered transcription (B1)", () => {
  it("does not start when the dictation words clearly will not cover the meeting", async () => {
    wordBudget = 1_000;
    try {
      const harness = createHarness({
        segments: [audioSegment(0, 20 * 60_000)],
      });
      await harness.pipeline.process("note");

      expect(harness.transcribeCalls).toEqual([]);
      expect(harness.store.getNote("note")).toMatchObject({
        status: "failed",
        error: {
          code: DICTATION_WORDS_EXCEEDED_ERROR_CODE,
          details: { neededWords: 3_000, remainingWords: 1_000 },
        },
      });
      expect(harness.deleted).toEqual([]);
    } finally {
      wordBudget = null;
    }
  });

  it("starts when the words cover the meeting and records where it was processed", async () => {
    wordBudget = 1_000;
    try {
      const harness = createHarness({ segments: [audioSegment(0, 60_000)] });
      await harness.pipeline.process("note");
      expect(harness.store.getNote("note")).toMatchObject({
        status: "ready",
        processedWith: PROCESSED_ON_DEVICE,
      });
    } finally {
      wordBudget = null;
    }
  });

  it("stops cleanly when the words run out half-way, and Retry continues where it stopped", async () => {
    const harness = createHarness({
      segments: [audioSegment(0, 10 * 60_000)],
    });
    harness.setTranscribeFailure(
      2,
      new NoteProcessingError(
        DICTATION_WORDS_EXCEEDED_ERROR_CODE,
        "out of words",
        { remainingWords: 0 },
      ),
    );
    await harness.pipeline.process("note");

    expect(harness.transcribeCalls).toHaveLength(2);
    expect(harness.store.getNote("note")?.error?.code).toBe(
      DICTATION_WORDS_EXCEEDED_ERROR_CODE,
    );
    const done = harness.store.getSegments("note")[0].transcribedMs;
    expect(done).toBeGreaterThan(0);
    expect(harness.deleted).toEqual([]);

    harness.setTranscribeFailure(null);
    await harness.store.updateNote("note", (note) => {
      note.status = "pending";
    });
    await harness.pipeline.process("note");
    expect(harness.store.getNote("note")?.status).toBe("ready");
    expect(harness.transcribeCalls.length).toBeGreaterThan(2);
  });
});
