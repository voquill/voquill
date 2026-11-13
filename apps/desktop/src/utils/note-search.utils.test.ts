import type { Note } from "@voquill/types";
import { describe, expect, it } from "vitest";
import {
  buildNoteSnippet,
  extractQuestionTerms,
  extractSearchTerms,
  getAskSources,
  rankNoteSearchResults,
  selectAskPassages,
  splitHighlights,
  splitTextIntoChunks,
  type NoteSearchDocument,
} from "./note-search.utils";

const makeNote = (overrides: Partial<Note>): Note => ({
  id: "n1",
  storage: "local",
  status: "ready",
  title: "Weekly sync",
  titleSource: "ai",
  error: null,
  source: "recording",
  personalNotes: "",
  generatedNotes: null,
  durationMs: 0,
  createdAt: "2026-01-01T10:00:00.000Z",
  updatedAt: "2026-01-01T10:00:00.000Z",
  cloud: null,
  ...overrides,
});

const doc = (note: Partial<Note>, transcript = ""): NoteSearchDocument => ({
  note: makeNote(note),
  transcript,
});

describe("search terms", () => {
  it("lowercases, splits on punctuation and dedupes", () => {
    expect(extractSearchTerms("  Q3 budget, budget—Zoë! ")).toEqual([
      "q3",
      "budget",
      "zoë",
    ]);
  });

  it("drops stopwords and single letters from questions", () => {
    expect(
      extractQuestionTerms("What did we decide about the budget in Q3?"),
    ).toEqual(["decide", "budget", "q3"]);
  });
});

describe("buildNoteSnippet", () => {
  it("shows context around the first match with ellipses", () => {
    const transcript = `${"lorem ipsum ".repeat(20)}we agreed the budget is final ${"dolor sit ".repeat(30)}`;
    const snippet = buildNoteSnippet(doc({}, transcript), ["budget"]);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("we agreed the budget is final");
    expect(snippet.length).toBeLessThan(230);
  });

  it("prefers AI notes over the transcript and strips markdown", () => {
    const snippet = buildNoteSnippet(
      doc({ generatedNotes: "## Decisions\n- **Budget** approved" }, "budget"),
      ["budget"],
    );
    expect(snippet).toBe("Decisions Budget approved");
  });

  it("uses the user's notes when only they match", () => {
    expect(
      buildNoteSnippet(
        doc({ generatedNotes: "Nothing here", personalNotes: "ask Sam" }),
        ["sam"],
      ),
    ).toBe("ask Sam");
  });

  it("falls back to the start of the notes when only the title matched", () => {
    expect(
      buildNoteSnippet(doc({ generatedNotes: "Short summary." }), ["weekly"]),
    ).toBe("Short summary.");
  });
});

describe("rankNoteSearchResults", () => {
  it("ranks title matches above transcript matches, then newest first", () => {
    const results = rankNoteSearchResults(
      [
        doc({ id: "old", title: "Budget", createdAt: "2026-01-01T00:00:00Z" }),
        doc({ id: "body", title: "Other" }, "the budget"),
        doc({ id: "new", title: "Budget", createdAt: "2026-02-01T00:00:00Z" }),
      ],
      ["budget"],
    );
    expect(results.map((result) => result.note.id)).toEqual([
      "new",
      "old",
      "body",
    ]);
  });
});

describe("splitHighlights", () => {
  it("marks every case-insensitive match", () => {
    expect(splitHighlights("Budget and budgets", ["budget"])).toEqual([
      { text: "Budget", match: true },
      { text: " and ", match: false },
      { text: "budget", match: true },
      { text: "s", match: false },
    ]);
  });

  it("returns the whole text when nothing matches", () => {
    expect(splitHighlights("plain", ["x"])).toEqual([
      { text: "plain", match: false },
    ]);
  });
});

describe("splitTextIntoChunks", () => {
  it("keeps paragraphs together up to the limit", () => {
    expect(splitTextIntoChunks("aaa\n\nbbb\n\nccc", 8)).toEqual([
      "aaa\n\nbbb",
      "ccc",
    ]);
  });

  it("splits long paragraphs at sentences, then hard", () => {
    const chunks = splitTextIntoChunks("One two. Three four. Five six.", 12);
    expect(chunks).toEqual(["One two.", "Three four.", "Five six."]);
    expect(splitTextIntoChunks("x".repeat(25), 10)).toEqual([
      "x".repeat(10),
      "x".repeat(10),
      "x".repeat(5),
    ]);
  });

  it("returns nothing for blank text", () => {
    expect(splitTextIntoChunks("  \n ", 10)).toEqual([]);
  });
});

describe("ask retrieval", () => {
  const documents = [
    doc(
      { id: "a", title: "Planning" },
      `Intro chatter.\n\n${"filler ".repeat(200)}\n\nThe budget is 10k.`,
    ),
    doc({ id: "b", title: "Retro", generatedNotes: "Went well." }),
  ];

  it("keeps the passages that mention the question's terms", () => {
    const passages = selectAskPassages({
      documents,
      terms: ["budget"],
      maxChars: 10_000,
    });
    expect(passages).toHaveLength(1);
    expect(passages[0].text).toContain("The budget is 10k.");
    expect(passages[0].text).not.toContain("Intro chatter.");
    expect(getAskSources(passages)).toEqual([
      { noteId: "a", title: "Planning" },
    ]);
  });

  it("falls back to leading passages within the budget when nothing matches", () => {
    const passages = selectAskPassages({
      documents,
      terms: ["summarize"],
      maxChars: 100,
    });
    expect(passages.map((passage) => passage.text)).toEqual([
      "Intro chatter.",
      "Went well.",
    ]);
    expect(
      passages.reduce((sum, p) => sum + p.text.length, 0),
    ).toBeLessThanOrEqual(100);
  });
});
