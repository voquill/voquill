import { describe, expect, it } from "vitest";
import type { GenerateTextInput } from "../repos/generate-text.repo";
import {
  buildNotesPrompt,
  cleanGeneratedMarkdown,
  cleanGeneratedTitle,
  generateNoteMarkdown,
  NOTE_GENERATION_CHUNK_CHARS,
} from "./note-prompt.utils";

const recordingGenerator = (reply: (input: GenerateTextInput) => string) => {
  const prompts: string[] = [];
  return {
    prompts,
    generator: {
      async generateText(input: GenerateTextInput) {
        prompts.push(input.prompt);
        return { text: reply(input) };
      },
    },
  };
};

describe("generateNoteMarkdown", () => {
  it("uses a single call for transcripts that fit", async () => {
    const { generator, prompts } = recordingGenerator(
      () => "```markdown\n## Summary\nShort.\n```",
    );
    const markdown = await generateNoteMarkdown({
      generator,
      transcript: "We met briefly.",
      personalNotes: "focus on hiring",
    });
    expect(markdown).toBe("## Summary\nShort.");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("We met briefly.");
    expect(prompts[0]).toContain("focus on hiring");
  });

  it("summarizes long transcripts part by part, then combines", async () => {
    const paragraph = "word ".repeat(1_000).trim();
    const transcript = Array.from({ length: 12 }, () => paragraph).join("\n\n");
    expect(transcript.length).toBeGreaterThan(NOTE_GENERATION_CHUNK_CHARS * 2);

    const { generator, prompts } = recordingGenerator((input) =>
      input.prompt.startsWith("This is part")
        ? "- partial"
        : "## Summary\nAll.",
    );
    const markdown = await generateNoteMarkdown({
      generator,
      transcript,
      personalNotes: "",
    });

    expect(markdown).toBe("## Summary\nAll.");
    const partPrompts = prompts.filter((prompt) =>
      prompt.startsWith("This is part"),
    );
    expect(partPrompts.length).toBeGreaterThanOrEqual(3);
    expect(partPrompts[0]).toContain(`part 1 of ${partPrompts.length}`);
    for (const prompt of prompts) {
      expect(prompt.length).toBeLessThan(NOTE_GENERATION_CHUNK_CHARS + 3_000);
    }
    expect(prompts.at(-1)).toContain("Combine these notes");
    expect(prompts.at(-1)).toContain("## Action items");
  });
});

describe("prompt text", () => {
  it("omits the user notes block when there are none", () => {
    expect(
      buildNotesPrompt({ transcript: "t", personalNotes: " " }),
    ).not.toContain("<user_notes>");
  });
});

describe("cleanGeneratedTitle", () => {
  it.each([
    ['"Quarterly budget review."', "Quarterly budget review"],
    ["# Hiring plan\nextra", "Hiring plan"],
    ["Title: Roadmap", "Roadmap"],
    ["", ""],
  ])("cleans %j", (input, expected) => {
    expect(cleanGeneratedTitle(input)).toBe(expected);
  });

  it("truncates very long titles", () => {
    expect(cleanGeneratedTitle("x".repeat(200)).length).toBe(100);
  });
});

describe("cleanGeneratedMarkdown", () => {
  it("keeps unfenced markdown as is", () => {
    expect(cleanGeneratedMarkdown("  ## A\n- b  ")).toBe("## A\n- b");
  });
});
