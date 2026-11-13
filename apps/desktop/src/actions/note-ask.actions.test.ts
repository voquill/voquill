import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NoteAskEvent,
  NoteAskInput,
} from "../pipelines/base-note.pipeline";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";

type AskScript = (input: NoteAskInput) => AsyncGenerator<NoteAskEvent>;

const fakes = vi.hoisted(() => ({
  script: null as AskScript | null,
  inputs: [] as NoteAskInput[],
}));

vi.mock("../pipelines", () => ({
  selectNoteStorage: () => "local",
  getNotePipeline: () => ({
    ask: (input: NoteAskInput) => {
      fakes.inputs.push(input);
      return fakes.script!(input);
    },
  }),
}));

vi.mock("./note-store.actions", () => ({
  noteStore: { getNote: () => ({ storage: "local" }) },
}));

const {
  askNotes,
  clearNotesAsk,
  getNoteAskThread,
  setNotesAskExpanded,
  stopAskingNotes,
} = await import("./note-ask.actions");

const thread = (noteId: string | null) =>
  getNoteAskThread(getAppState(), noteId);

const answers = (noteId: string | null) =>
  (thread(noteId)?.messages ?? []).filter((m) => m.role === "assistant");

/** Yields events, then waits until released (or aborted). */
const scripted = (events: NoteAskEvent[], hold?: Promise<void>): AskScript =>
  async function* () {
    for (const event of events) {
      yield event;
    }
    if (hold) {
      await hold;
    }
  };

beforeEach(() => {
  setAppState(structuredClone(INITIAL_APP_STATE));
  fakes.inputs = [];
  fakes.script = null;
});

describe("Ask threads", () => {
  it("streams an answer, then replaces it with the final answer and sources", async () => {
    fakes.script = scripted([
      { type: "sources", sources: [{ noteId: "n1", title: "Standup" }] },
      { type: "delta", text: "Ship " },
      { type: "delta", text: "Friday" },
      {
        type: "done",
        answer: "Ship on Friday [1].",
        sources: [{ noteId: "n1", title: "Standup" }],
      },
    ]);

    await askNotes("n1", "  When do we ship?  ");

    const [question, answer] = thread("n1")!.messages;
    expect(question).toMatchObject({
      role: "user",
      content: "When do we ship?",
    });
    expect(answer).toMatchObject({
      content: "Ship on Friday [1].",
      streaming: false,
      stopped: false,
      error: null,
      sources: [{ noteId: "n1", title: "Standup" }],
    });
    expect(thread("n1")!.expanded).toBe(true);
  });

  it("sends earlier turns as history, without failed answers", async () => {
    fakes.script = scripted([{ type: "done", answer: "Friday.", sources: [] }]);
    await askNotes("n1", "When?");
    fakes.script = scripted([{ type: "error", message: "ask_failed" }]);
    await askNotes("n1", "Who?");
    fakes.script = scripted([{ type: "done", answer: "Sam.", sources: [] }]);
    await askNotes("n1", "Who owns it?");

    expect(fakes.inputs[2].history).toEqual([
      { role: "user", content: "When?" },
      { role: "assistant", content: "Friday." },
      { role: "user", content: "Who?" },
    ]);
    expect(fakes.inputs[2].noteId).toBe("n1");
  });

  it("keeps a separate thread per note and for all notes", async () => {
    fakes.script = scripted([{ type: "done", answer: "A", sources: [] }]);
    await askNotes("n1", "About n1");
    await askNotes(null, "Across notes");

    expect(thread("n1")!.messages[0].content).toBe("About n1");
    expect(thread(null)!.messages[0].content).toBe("Across notes");
    expect(fakes.inputs[1].noteId).toBeNull();
  });

  it("ignores a new question while the thread is answering", async () => {
    let release!: () => void;
    fakes.script = scripted(
      [{ type: "delta", text: "Thinking" }],
      new Promise<void>((resolve) => (release = resolve)),
    );
    const first = askNotes("n1", "First");
    await vi.waitFor(() => expect(answers("n1")[0]?.content).toBe("Thinking"));
    await askNotes("n1", "Second");
    release();
    await first;

    expect(fakes.inputs).toHaveLength(1);
    expect(thread("n1")!.messages).toHaveLength(2);
  });

  it("stops an answer and keeps what streamed so far", async () => {
    fakes.script = async function* (input) {
      yield { type: "delta", text: "Partial" };
      await new Promise<void>((resolve) =>
        input.signal?.addEventListener("abort", () => resolve()),
      );
      yield { type: "delta", text: " never shown" };
    };
    const asking = askNotes("n1", "Question");
    await vi.waitFor(() => expect(answers("n1")[0]?.content).toBe("Partial"));
    stopAskingNotes("n1");
    await asking;

    expect(answers("n1")[0]).toMatchObject({
      content: "Partial",
      streaming: false,
      stopped: true,
      error: null,
    });
  });

  it("records the daily limit so the box can say when Ask is back", async () => {
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    fakes.script = scripted([
      { type: "error", message: "ask_limit_exceeded", details: { resetsAt } },
    ]);
    await askNotes(null, "Anything?");

    expect(answers(null)[0].error).toBe("ask_limit_exceeded");
    expect(getAppState().notes.askLimitResetsAt).toBe(resetsAt);
  });

  it("makes Ask available again when the limit resets", async () => {
    vi.useFakeTimers();
    try {
      const resetsAt = new Date(Date.now() + 60_000).toISOString();
      fakes.script = scripted([
        { type: "error", message: "ask_limit_exceeded", details: { resetsAt } },
      ]);
      await askNotes(null, "Anything?");
      expect(getAppState().notes.askLimitResetsAt).toBe(resetsAt);
      vi.advanceTimersByTime(60_000);
      expect(getAppState().notes.askLimitResetsAt).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("collapses only when there is a thread, and clearing removes it", async () => {
    setNotesAskExpanded("n1", true);
    expect(thread("n1")!.expanded).toBe(false);

    fakes.script = scripted([{ type: "done", answer: "A", sources: [] }]);
    await askNotes("n1", "Q");
    setNotesAskExpanded("n1", false);
    expect(thread("n1")!.expanded).toBe(false);
    setNotesAskExpanded("n1", true);
    expect(thread("n1")!.expanded).toBe(true);

    clearNotesAsk("n1");
    expect(thread("n1")).toBeUndefined();
  });
});
