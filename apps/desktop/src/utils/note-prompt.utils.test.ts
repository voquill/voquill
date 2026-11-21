import type { NoteSegment } from "@voquill/types";
import { describe, expect, it } from "vitest";
import type { GenerateTextInput } from "../repos/generate-text.repo";
import {
  cleanGeneratedMarkdown,
  cleanGeneratedTitle,
  createPromptNoteWriter,
  EMPTY_TRANSCRIPT_NOTES,
  estimateTokens,
  formatNoteTranscriptForModel,
  generateNoteContent,
  getSinglePassBudgetTokens,
  parseGeneratedNoteOutput,
  splitLinesForMap,
  type NoteMaterial,
  type NoteWriter,
} from "./note-prompt.utils";

const recordingModel = (
  contextTokens: number,
  reply: (input: GenerateTextInput) => string,
) => {
  const requests: GenerateTextInput[] = [];
  return {
    requests,
    model: createPromptNoteWriter({
      contextTokens,
      generator: {
        async generateText(input: GenerateTextInput) {
          requests.push(input);
          return { text: reply(input) };
        },
      },
    }),
  };
};

/** A writer that records each step; section notes are a tenth of their input. */
const recordingWriter = (maxInputTokens: number) => {
  const steps: { stage: string; part: NoteMaterial }[] = [];
  const writer: NoteWriter = {
    maxInputTokens,
    async writeSection(_input, part) {
      steps.push({ stage: "section", part });
      return "x".repeat(Math.ceil(part.body.length / 10));
    },
    async writeNotes(_input, material) {
      steps.push({ stage: "final", part: material });
      return { title: "T", notes: "N" };
    },
  };
  return { writer, steps };
};

const input = {
  personalNotes: "",
  wantTitle: true,
  meetingDate: "2026-05-01",
};

describe("generateNoteContent", () => {
  it("asks once for a JSON title and notes in the server's format", async () => {
    const { model, requests } = recordingModel(32_768, () =>
      JSON.stringify({
        title: '"Hiring sync"',
        notes: "The team met.\n\n## Action items\n- [ ] Draft plan —",
      }),
    );
    const content = await generateNoteContent(model, {
      ...input,
      transcript: "[00:00] Speaker 1: We should hire.",
      personalNotes: "focus on hiring",
    });

    expect(content).toEqual({
      title: "Hiring sync",
      notes: "The team met.\n\n## Action items\n- [ ] Draft plan",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].system).toContain('"## Key points"');
    expect(requests[0].system).toContain('"## Open questions"');
    expect(requests[0].system).toContain('{"title": string, "notes": string}');
    expect(requests[0].prompt).toContain("Meeting date: 2026-05-01");
    expect(requests[0].prompt).toContain("<user_notes>\nfocus on hiring");
    expect(requests[0].prompt).toContain("<transcript>");
    expect(requests[0].jsonResponse?.schema).toMatchObject({
      required: ["title", "notes"],
    });
  });

  it("skips the model for a transcript without speech", async () => {
    const { model, requests } = recordingModel(32_768, () => "unused");
    expect(
      await generateNoteContent(model, { ...input, transcript: " " }),
    ).toEqual({ title: null, notes: EMPTY_TRANSCRIPT_NOTES });
    expect(requests).toEqual([]);
  });

  it("keeps every request within a small model's context", async () => {
    const line = `[00:00] Speaker: ${"word ".repeat(400).trim()}`;
    const transcript = Array.from({ length: 40 }, () => line).join("\n");
    const { model, requests } = recordingModel(4_096, (request) =>
      request.system?.includes("one section of a long meeting")
        ? "- point"
        : JSON.stringify({ title: "Long meeting", notes: "Summary." }),
    );

    const content = await generateNoteContent(model, { ...input, transcript });

    expect(content.notes).toBe("Summary.");
    expect(requests.length).toBeGreaterThan(2);
    for (const request of requests) {
      const tokens = estimateTokens(`${request.system}\n${request.prompt}`);
      expect(tokens).toBeLessThan(4_096);
    }
    expect(requests.at(-1)?.prompt).toContain("<section_notes>");
  });

  it("merges section notes for as many rounds as a transcript needs", async () => {
    const line = `[00:00] Speaker 1: ${"word ".repeat(100).trim()}`;
    const transcript = Array.from({ length: 3_000 }, () => line).join("\n");
    const { writer, steps } = recordingWriter(2_000);

    expect(await generateNoteContent(writer, { ...input, transcript })).toEqual(
      {
        title: "T",
        notes: "N",
      },
    );

    for (const step of steps) {
      expect(estimateTokens(step.part.body)).toBeLessThanOrEqual(2_000);
    }
    const sectionLabels = new Set(
      steps.filter((s) => s.stage === "section").map((s) => s.part.label),
    );
    expect(sectionLabels).toEqual(new Set(["transcript", "section_notes"]));
    expect(steps.at(-1)).toMatchObject({
      stage: "final",
      part: { label: "section_notes" },
    });
  });

  it("fails instead of looping when section notes do not get shorter", async () => {
    const transcript = Array.from({ length: 50 }, () =>
      "word ".repeat(100),
    ).join("\n");
    const writer: NoteWriter = {
      maxInputTokens: 500,
      writeSection: async (_input, part) => part.body,
      writeNotes: async () => ({ title: null, notes: "unused" }),
    };
    await expect(
      generateNoteContent(writer, { ...input, transcript }),
    ).rejects.toThrow("no shorter");
  });

  it("caps personal notes so they cannot crowd out the transcript", async () => {
    const { model, requests } = recordingModel(4_096, () =>
      JSON.stringify({ title: "T", notes: "N" }),
    );
    await generateNoteContent(model, {
      ...input,
      transcript: "[00:00] Speaker 1: Hello.",
      personalNotes: "mine ".repeat(10_000),
    });
    expect(
      estimateTokens(`${requests[0].system}\n${requests[0].prompt}`),
    ).toBeLessThan(4_096);
  });

  it("uses the server's single-pass budget for large contexts", () => {
    expect(getSinglePassBudgetTokens(131_072)).toBe(64_000);
    expect(getSinglePassBudgetTokens(4_096)).toBeLessThan(3_000);
  });
});

describe("splitLinesForMap", () => {
  it("splits a pasted transcript without line breaks", () => {
    const text = "word ".repeat(10_000).trim();
    const windows = splitLinesForMap(text, 1_000);
    expect(windows.length).toBeGreaterThan(10);
    for (const window of windows) {
      expect(estimateTokens(window)).toBeLessThanOrEqual(1_000);
    }
    expect(windows.join(" ")).toBe(text);
  });

  it("cuts a single word longer than a window", () => {
    const windows = splitLinesForMap("é".repeat(2_500), 1_000);
    expect(windows.map((w) => w.length)).toEqual([999, 999, 502]);
  });

  it("keeps lines whole when they fit", () => {
    expect(splitLinesForMap("a\nb\nc", 2)).toEqual(["a", "b", "c"]);
    expect(splitLinesForMap("a\nb\nc", 4)).toEqual(["a\nb", "c"]);
  });
});

describe("parseGeneratedNoteOutput", () => {
  it("falls back to the reply as markdown when it is not JSON", () => {
    expect(
      parseGeneratedNoteOutput("```markdown\nJust notes\n```", true),
    ).toEqual({
      title: null,
      notes: "Just notes",
    });
  });

  it("ignores a title that was not asked for", () => {
    expect(
      parseGeneratedNoteOutput('{"title":"x","notes":"n"}', false),
    ).toEqual({ title: null, notes: "n" });
  });
});

describe("formatNoteTranscriptForModel", () => {
  const segment = (
    index: number,
    transcript: NoteSegment["transcript"],
  ): NoteSegment => ({
    id: `s${index}`,
    noteId: "n",
    index,
    kind: "audio",
    status: "transcribed",
    error: null,
    durationMs: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    transcript,
    transcribedMs: 0,
    audioPath: null,
    upload: null,
  });

  it("labels timed turns and recording parts like the server", () => {
    expect(
      formatNoteTranscriptForModel([
        segment(1, {
          text: "",
          utterances: [
            { startMs: 61_000, endMs: 62_000, speaker: 0, text: "Hi." },
            { startMs: 62_000, endMs: 63_000, speaker: 0, text: "Again." },
            { startMs: 64_000, endMs: 65_000, speaker: 1, text: "Yes." },
          ],
        }),
        segment(0, { text: "Pasted text", utterances: [] }),
        segment(2, null),
      ]),
    ).toBe(
      "--- Recording part 1 ---\nPasted text\n\n--- Recording part 2 ---\n[01:01] Speaker 1: Hi. Again.\n[01:04] Speaker 2: Yes.",
    );
  });
});

describe("cleanGeneratedTitle", () => {
  it.each([
    ['"Quarterly budget review"', "Quarterly budget review"],
    ["# Hiring plan", "Hiring plan"],
    ["", null],
  ])("cleans %j", (raw, expected) => {
    expect(cleanGeneratedTitle(raw)).toBe(expected);
  });
});

describe("cleanGeneratedMarkdown", () => {
  it("keeps unfenced markdown as is", () => {
    expect(cleanGeneratedMarkdown("  ## A\n- b  ")).toBe("## A\n- b");
  });
});
