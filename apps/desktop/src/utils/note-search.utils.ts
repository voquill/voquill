import type { Note } from "@voquill/types";

export type NoteSearchField =
  | "title"
  | "generatedNotes"
  | "personalNotes"
  | "transcript";

export type NoteSearchDocument = {
  note: Note;
  transcript: string;
};

export type NoteSearchResult = {
  note: Note;
  snippet: string;
  score: number;
};

const FIELD_WEIGHTS: Record<NoteSearchField, number> = {
  title: 5,
  generatedNotes: 3,
  personalNotes: 3,
  transcript: 1,
};

const SNIPPET_FIELDS: NoteSearchField[] = [
  "generatedNotes",
  "personalNotes",
  "transcript",
  "title",
];

const SNIPPET_CONTEXT_CHARS = 70;

const QUESTION_STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have how i if in " +
    "into is it its me my of on or our so than that the their them then there these they this " +
    "to us was we were what when where which who whom why will with would you your about any " +
    "all some tell said say says meeting meetings note notes"
  ).split(" "),
);

const tokenize = (text: string): string[] =>
  text
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

const dedupe = (terms: string[]): string[] => [...new Set(terms)];

/** Every word of a search query; notes must contain all of them. */
export const extractSearchTerms = (query: string): string[] =>
  dedupe(tokenize(query));

/** The meaningful words of a question, used to retrieve notes for Ask. */
export const extractQuestionTerms = (question: string): string[] =>
  dedupe(
    tokenize(question).filter(
      (term) => term.length > 1 && !QUESTION_STOPWORDS.has(term),
    ),
  );

export const getNoteSearchFieldText = (
  document: NoteSearchDocument,
  field: NoteSearchField,
): string => {
  switch (field) {
    case "title":
      return document.note.title;
    case "generatedNotes":
      return document.note.generatedNotes ?? "";
    case "personalNotes":
      return document.note.personalNotes;
    case "transcript":
      return document.transcript;
  }
};

const countOccurrences = (haystack: string, needle: string): number => {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
};

/** Weighted term frequency; matches in titles and notes count more than in the transcript. */
export const scoreNoteDocument = (
  document: NoteSearchDocument,
  terms: string[],
): number => {
  let score = 0;
  for (const field of Object.keys(FIELD_WEIGHTS) as NoteSearchField[]) {
    const text = getNoteSearchFieldText(document, field).toLocaleLowerCase();
    for (const term of terms) {
      score += FIELD_WEIGHTS[field] * Math.min(countOccurrences(text, term), 5);
    }
  }
  return score;
};

const collapseWhitespace = (text: string): string =>
  text.replace(/\s+/g, " ").trim();

const stripMarkdown = (text: string): string =>
  text.replace(/[#*_`>|[\]]+/g, " ").replace(/^\s*[-+]\s+/gm, " ");

/**
 * A short excerpt around the first match, preferring the AI notes, then the
 * user's notes, then the transcript. Falls back to the start of the AI notes
 * or transcript when only the title matched.
 */
export const buildNoteSnippet = (
  document: NoteSearchDocument,
  terms: string[],
): string => {
  for (const field of SNIPPET_FIELDS) {
    const text = collapseWhitespace(
      stripMarkdown(getNoteSearchFieldText(document, field)),
    );
    const lower = text.toLocaleLowerCase();
    const matchIndex = terms
      .map((term) => lower.indexOf(term))
      .filter((index) => index !== -1)
      .reduce((min, index) => Math.min(min, index), Number.POSITIVE_INFINITY);
    if (!Number.isFinite(matchIndex) || field === "title") {
      continue;
    }

    let start = Math.max(0, matchIndex - SNIPPET_CONTEXT_CHARS);
    let end = Math.min(text.length, matchIndex + SNIPPET_CONTEXT_CHARS * 2);
    if (start > 0) {
      const space = text.indexOf(" ", start);
      start = space !== -1 && space < matchIndex ? space + 1 : start;
    }
    if (end < text.length) {
      const space = text.lastIndexOf(" ", end);
      end = space > matchIndex ? space : end;
    }
    return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
  }

  const fallback = collapseWhitespace(
    stripMarkdown(document.note.generatedNotes ?? document.transcript),
  );
  return fallback.length > SNIPPET_CONTEXT_CHARS * 3
    ? `${fallback.slice(0, SNIPPET_CONTEXT_CHARS * 3)}…`
    : fallback;
};

export const rankNoteSearchResults = (
  documents: NoteSearchDocument[],
  terms: string[],
): NoteSearchResult[] =>
  documents
    .map((document) => ({
      note: document.note,
      snippet: buildNoteSnippet(document, terms),
      score: scoreNoteDocument(document, terms),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.note.createdAt.localeCompare(left.note.createdAt),
    );

export type TextPart = { text: string; match: boolean };

/** Splits text into matching and non-matching parts for highlighting. */
export const splitHighlights = (text: string, terms: string[]): TextPart[] => {
  const lower = text.toLocaleLowerCase();
  const parts: TextPart[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let nextIndex = -1;
    let nextTerm = "";
    for (const term of terms) {
      const index = lower.indexOf(term, cursor);
      if (
        index !== -1 &&
        (nextIndex === -1 ||
          index < nextIndex ||
          (index === nextIndex && term.length > nextTerm.length))
      ) {
        nextIndex = index;
        nextTerm = term;
      }
    }
    if (nextIndex === -1 || !nextTerm) {
      parts.push({ text: text.slice(cursor), match: false });
      break;
    }
    if (nextIndex > cursor) {
      parts.push({ text: text.slice(cursor, nextIndex), match: false });
    }
    parts.push({
      text: text.slice(nextIndex, nextIndex + nextTerm.length),
      match: true,
    });
    cursor = nextIndex + nextTerm.length;
  }
  return parts;
};

export type NoteAskSource = {
  noteId: string;
  title: string;
};

export type NoteAskPassage = {
  noteId: string;
  title: string;
  createdAt: string;
  text: string;
};

const PASSAGE_CHARS = 1_200;

/** Splits a note's content into passages labelled by note, for retrieval. */
export const splitNoteIntoPassages = (
  document: NoteSearchDocument,
): NoteAskPassage[] => {
  const { note } = document;
  const sections = [
    note.generatedNotes ?? "",
    note.personalNotes,
    document.transcript,
  ];
  return sections.flatMap((section) =>
    splitTextIntoChunks(section, PASSAGE_CHARS).map((text) => ({
      noteId: note.id,
      title: note.title,
      createdAt: note.createdAt,
      text,
    })),
  );
};

/**
 * The passages to answer from, within `maxChars`: the best matches for the
 * question's terms, or each note's leading passages when nothing matches
 * (questions such as "summarize this"). Passages keep their note order.
 */
export const selectAskPassages = ({
  documents,
  terms,
  maxChars,
}: {
  documents: NoteSearchDocument[];
  terms: string[];
  maxChars: number;
}): NoteAskPassage[] => {
  const passages = documents.flatMap(splitNoteIntoPassages);
  const scored = passages.map((passage, order) => {
    const lower = passage.text.toLocaleLowerCase();
    const score = terms.reduce(
      (sum, term) => sum + Math.min(countOccurrences(lower, term), 5),
      0,
    );
    return { passage, order, score };
  });
  const anyMatch = scored.some((entry) => entry.score > 0);
  const ranked = anyMatch
    ? scored
        .filter((entry) => entry.score > 0)
        .sort(
          (left, right) => right.score - left.score || left.order - right.order,
        )
    : scored;

  const picked: typeof scored = [];
  let used = 0;
  for (const entry of ranked) {
    if (used + entry.passage.text.length > maxChars) {
      continue;
    }
    picked.push(entry);
    used += entry.passage.text.length;
  }
  return picked
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.passage);
};

/** Numbered sources in the order their notes first appear in the passages. */
export const getAskSources = (passages: NoteAskPassage[]): NoteAskSource[] => {
  const sources: NoteAskSource[] = [];
  for (const passage of passages) {
    if (!sources.some((source) => source.noteId === passage.noteId)) {
      sources.push({ noteId: passage.noteId, title: passage.title });
    }
  }
  return sources;
};

/** The sources an answer cites as `[n]`; all of them if it cites none. */
export const getCitedAskSources = (
  answer: string,
  sources: NoteAskSource[],
): NoteAskSource[] => {
  const cited = new Set(
    [...answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])),
  );
  const filtered = sources.filter((_, index) => cited.has(index + 1));
  return filtered.length > 0 ? filtered : sources;
};

/**
 * Splits text into pieces of at most `maxChars`, breaking at paragraphs,
 * then sentences, then words.
 */
export const splitTextIntoChunks = (
  text: string,
  maxChars: number,
): string[] => {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.length <= maxChars) {
    return [trimmed];
  }

  type Piece = { text: string; startsParagraph: boolean };
  const hardSplit = (piece: string): string[] => {
    const parts: string[] = [];
    for (let start = 0; start < piece.length; start += maxChars) {
      parts.push(piece.slice(start, start + maxChars));
    }
    return parts;
  };
  const pieces: Piece[] = trimmed.split(/\n\s*\n/).flatMap((paragraph) => {
    const sentences =
      paragraph.length <= maxChars
        ? [paragraph]
        : (paragraph.match(/[^.!?。！？]+[.!?。！？]*\s*/g) ?? [paragraph]);
    return sentences
      .flatMap((sentence) =>
        sentence.length <= maxChars ? [sentence.trim()] : hardSplit(sentence),
      )
      .filter(Boolean)
      .map((text, index) => ({ text, startsParagraph: index === 0 }));
  });

  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    const separator = current ? (piece.startsParagraph ? "\n\n" : " ") : "";
    if (
      current &&
      current.length + separator.length + piece.text.length > maxChars
    ) {
      chunks.push(current);
      current = piece.text;
    } else {
      current = `${current}${separator}${piece.text}`;
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
};
