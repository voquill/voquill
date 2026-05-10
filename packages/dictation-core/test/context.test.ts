import { describe, expect, it } from "vitest";
import { assembleDictationContext } from "../src/index";

describe("assembleDictationContext", () => {
  it("preserves glossary entries, replacement destinations, and editor context", () => {
    const context = assembleDictationContext({
      intent: { kind: "dictation", format: "clean" },
      language: "en",
      currentApp: { id: "notes", name: "Notes" },
      currentEditor: { id: "body", name: "Document Body" },
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

    expect(context.glossaryTerms).toEqual(["voquill", "GraphQL"]);
    expect(context.replacementMap).toEqual({ voquill: "Voquill" });
    expect(context.currentApp).toEqual({ id: "notes", name: "Notes" });
    expect(context.currentEditor).toEqual({
      id: "body",
      name: "Document Body",
    });
  });

  it("strips NUL bytes while normalizing glossary and replacement values", () => {
    const context = assembleDictationContext({
      intent: { kind: "dictation", format: "clean" },
      language: "en",
      terms: [
        {
          sourceValue: "\0Vo\0quill  ",
          destinationValue: "\0Voquill\0",
          isReplacement: true,
        },
      ],
    });

    expect(context.glossaryTerms).toEqual(["Voquill"]);
    expect(context.replacementMap).toEqual({ Voquill: "Voquill" });
  });

  it("sanitizes and preserves selected text and screen context", () => {
    const context = assembleDictationContext({
      intent: { kind: "dictation", format: "clean" },
      language: "en",
      selectedText: "  Draft\0 summary \n section  ",
      screenContext: "\0Docs window  \n release checklist  ",
    } as Parameters<typeof assembleDictationContext>[0] & {
      selectedText: string;
      screenContext: string;
    });

    expect(context).toMatchObject({
      selectedText: "Draft summary section",
      screenContext: "Docs window release checklist",
    });
  });
});
