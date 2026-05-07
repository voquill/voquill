import { describe, expect, it } from "vitest";
import {
  buildPostProcessingPrompt,
  buildSystemPostProcessingTonePrompt,
  PostProcessingPromptInput,
} from "./prompt.utils";
import { StyleToneConfig, TemplateToneConfig } from "./tone.utils";

const makeInput = (
  tone: StyleToneConfig | TemplateToneConfig,
  overrides: Partial<Omit<PostProcessingPromptInput, "tone">> = {},
): PostProcessingPromptInput => ({
  transcript: "Hello world",
  userName: "Alice",
  dictationLanguage: "en",
  tone,
  ...overrides,
});

describe("buildSystemPostProcessingTonePrompt", () => {
  it("returns default system prompt for style config", () => {
    const result = buildSystemPostProcessingTonePrompt(
      makeInput({ kind: "style", stylePrompt: "Be formal" }),
    );
    expect(result).toContain("transcript rewriting assistant");
  });

  it("returns custom system prompt for template config", () => {
    const result = buildSystemPostProcessingTonePrompt(
      makeInput({
        kind: "template",
        promptTemplate: "Process: <transcript/>",
        systemPromptTemplate: "You are a custom assistant for the enterprise.",
      }),
    );
    expect(result).toBe("You are a custom assistant for the enterprise.");
  });

  it("substitutes variables in template system prompt", () => {
    const result = buildSystemPostProcessingTonePrompt(
      makeInput(
        {
          kind: "template",
          promptTemplate: "ignored",
          systemPromptTemplate:
            "You assist <username/> with transcripts in <language/>.",
        },
        { userName: "Bob", dictationLanguage: "fr" },
      ),
    );
    expect(result).toBe("You assist Bob with transcripts in Français.");
  });

  it("falls back to default when template config has no systemPromptTemplate", () => {
    const result = buildSystemPostProcessingTonePrompt(
      makeInput({
        kind: "template",
        promptTemplate: "Process: <transcript/>",
      }),
    );
    expect(result).toContain("transcript rewriting assistant");
  });
});

describe("buildPostProcessingPrompt", () => {
  it("substitutes variables in template config", () => {
    const result = buildPostProcessingPrompt(
      makeInput({
        kind: "template",
        promptTemplate:
          "User <username/> said: <transcript/>. Respond in <language/>.",
      }),
    );
    expect(result).toBe("User Alice said: Hello world. Respond in English.");
  });

  it("substitutes multiple occurrences of the same variable", () => {
    const result = buildPostProcessingPrompt(
      makeInput(
        {
          kind: "template",
          promptTemplate: "<username/> (<username/>) wrote: <transcript/>",
        },
        { transcript: "test", userName: "Bob", dictationLanguage: "fr" },
      ),
    );
    expect(result).toBe("Bob (Bob) wrote: test");
  });

  it("uses standard prompt structure for style config", () => {
    const result = buildPostProcessingPrompt(
      makeInput({ kind: "style", stylePrompt: "Be formal" }),
    );
    expect(result).toContain(
      "Your task is to post-process an audio transcription",
    );
    expect(result).toContain("Be formal");
    expect(result).toContain("Hello world");
    expect(result).toContain("Alice");
    expect(result).toContain("English");
  });
});
