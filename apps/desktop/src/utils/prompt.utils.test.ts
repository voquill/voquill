import { describe, expect, it } from "vitest";
import {
  buildDictationContext,
  buildPostProcessingPrompt,
  buildSystemPostProcessingTonePrompt,
  mergeScreenContexts,
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

describe("buildDictationContext", () => {
  it("preserves replacement destinations in shared context assembly", () => {
    const result = buildDictationContext({
      dictationLanguage: "en",
      terms: [
        {
          sourceValue: "voquill",
          destinationValue: "Voquill",
          isReplacement: true,
        },
        {
          sourceValue: "GraphQL",
          destinationValue: "GraphQL",
          isReplacement: false,
        },
      ],
    });

    expect(result.glossaryTerms).toEqual(["voquill", "GraphQL"]);
    expect(result.replacementMap).toEqual({ voquill: "Voquill" });
  });

  it("preserves selected text and screen context in shared context assembly", () => {
    const result = buildDictationContext({
      dictationLanguage: "en",
      selectedText: "  Draft\0 summary \n section  ",
      screenContext: "\0Browser tab  \n product requirements  ",
    } as Parameters<typeof buildDictationContext>[0] & {
      selectedText: string;
      screenContext: string;
    });

    expect(result).toMatchObject({
      selectedText: "Draft summary section",
      screenContext: "Browser tab product requirements",
    });
  });
});

describe("mergeScreenContexts", () => {
  it("merges accessibility and screen capture context into a single payload", () => {
    const result = mergeScreenContexts({
      accessibilityContext: "  Browser tab \n release dashboard  ",
      screenCaptureContext: "\0Draft launch checklist  ",
    });

    expect(result).toBe(
      "Accessibility context: Browser tab release dashboard\nScreen capture OCR: Draft launch checklist",
    );
  });

  it("falls back to accessibility context when screen capture is unavailable", () => {
    const result = mergeScreenContexts({
      accessibilityContext: "  Release dashboard  ",
      screenCaptureContext: null,
    });

    expect(result).toBe("Release dashboard");
  });
});

describe("buildSystemPostProcessingTonePrompt", () => {
  it("returns default system prompt for style config", () => {
    const result = buildSystemPostProcessingTonePrompt(
      makeInput({ kind: "style", stylePrompt: "Be formal" }),
    );
    expect(result).toContain("Be formal");
    expect(result).toContain("English");
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
    expect(result).toContain("TRANSCRIPTION ENHANCER");
    expect(result).toContain("English");
  });

  it("includes app and editor context when available", () => {
    const result = buildSystemPostProcessingTonePrompt(
      makeInput(
        { kind: "style", stylePrompt: "Be formal" },
        {
          context: buildDictationContext({
            dictationLanguage: "en",
            currentApp: { id: "notes", name: "Notes" },
            currentEditor: { id: "body", name: "Document Body" },
            selectedText: "  Pending\0 launch \n notes  ",
            screenContext: "\0Browser tab  \n release dashboard  ",
          } as Parameters<typeof buildDictationContext>[0] & {
            selectedText: string;
            screenContext: string;
          }),
        },
      ),
    );

    expect(result).toContain("<ACTIVE_APP>");
    expect(result).toContain("Notes");
    expect(result).toContain("<CURRENTLY_SELECTED_TEXT>");
    expect(result).toContain("Pending launch notes");
    expect(result).toContain("<CURRENT_WINDOW_CONTEXT>");
    expect(result).toContain("Browser tab release dashboard");
  });

  it("includes CURRENT_WINDOW_CONTEXT when only screenContext is provided", () => {
    const result = buildSystemPostProcessingTonePrompt(
      makeInput(
        { kind: "style", stylePrompt: "Be formal" },
        {
          context: buildDictationContext({
            dictationLanguage: "en",
            screenContext: "Ghostty terminal with some text",
          } as Parameters<typeof buildDictationContext>[0] & {
            screenContext: string;
          }),
        },
      ),
    );

    expect(result).toContain("<CURRENT_WINDOW_CONTEXT>");
    expect(result).toContain("Ghostty terminal with some text");
    expect(result).not.toContain("<ACTIVE_APP>");
  });

  it("includes ACTIVE_APP when only currentApp is provided", () => {
    const result = buildSystemPostProcessingTonePrompt(
      makeInput(
        { kind: "style", stylePrompt: "Be formal" },
        {
          context: buildDictationContext({
            dictationLanguage: "en",
            currentApp: { id: "ghostty", name: "Ghostty" },
          }),
        },
      ),
    );

    expect(result).toContain("<ACTIVE_APP>");
    expect(result).toContain("Ghostty");
    expect(result).not.toContain("<CURRENT_WINDOW_CONTEXT>");
  });

  it("omits context sections when no context is provided", () => {
    const result = buildSystemPostProcessingTonePrompt(
      makeInput({ kind: "style", stylePrompt: "Be formal" }),
    );

    expect(result).not.toContain("<ACTIVE_APP>");
    expect(result).not.toContain("<CURRENT_WINDOW_CONTEXT>");
    expect(result).not.toContain("<CURRENTLY_SELECTED_TEXT>");
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
    expect(result).toContain("<TRANSCRIPT>");
    expect(result).toContain("Hello world");
    expect(result).toContain("</TRANSCRIPT>");
  });
});
