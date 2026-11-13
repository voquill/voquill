import type { LlmMessage } from "@voquill/types";
import type {
  GenerateTextInput,
  GenerateTextOutput,
} from "../repos/generate-text.repo";
import { splitTextIntoChunks, type NoteAskPassage } from "./note-search.utils";

/**
 * Prompts for local note generation and Ask. Wording should stay aligned with
 * the server's notes prompts so cloud and local notes read the same.
 */

export type NoteTextGenerator = {
  generateText(input: GenerateTextInput): Promise<GenerateTextOutput>;
};

/** Transcript text per LLM call; small enough for modest local context windows. */
export const NOTE_GENERATION_CHUNK_CHARS = 24_000;

const TITLE_SOURCE_CHARS = 6_000;
const MAX_TITLE_CHARS = 100;

const NOTES_SYSTEM_PROMPT = [
  "You write meeting notes from transcripts.",
  "Use only what the transcript says. Never invent names, numbers, decisions, owners or tasks.",
  "Write in the language of the transcript.",
  "Reply with GitHub-flavored markdown only, without any preamble or closing remarks.",
].join(" ");

const NOTES_FORMAT = `Use these sections, in this order, and leave out any section that would be empty:

## Summary
Two or three sentences on what the meeting was about and its outcome.

## Key points
Bullet points grouped under short "###" topic headings.

## Decisions
Bullet points.

## Action items
"- [ ] task" lines, followed by " — owner" only when the transcript states who owns it.

If the transcript has very little content, write only the Summary, in one sentence.`;

const personalNotesBlock = (personalNotes: string): string => {
  const trimmed = personalNotes.trim();
  if (!trimmed) {
    return "";
  }
  return `The user took these notes during the meeting. Use them to decide what to emphasize; do not treat them as transcript content.
<user_notes>
${trimmed}
</user_notes>

`;
};

export const buildNotesPrompt = ({
  transcript,
  personalNotes,
}: {
  transcript: string;
  personalNotes: string;
}): string => `Write notes for this meeting.

${NOTES_FORMAT}

${personalNotesBlock(personalNotes)}<transcript>
${transcript}
</transcript>`;

export const buildPartialNotesPrompt = ({
  transcript,
  personalNotes,
  part,
  partCount,
}: {
  transcript: string;
  personalNotes: string;
  part: number;
  partCount: number;
}): string => `This is part ${part} of ${partCount} of a long meeting transcript. Write faithful notes for this part only: the topics discussed, key points, decisions, and action items with owners when stated. Use markdown bullet points under short "###" topic headings.

${personalNotesBlock(personalNotes)}<transcript_part>
${transcript}
</transcript_part>`;

export const buildCombineNotesPrompt = ({
  partialNotes,
  personalNotes,
  isFinal,
}: {
  partialNotes: string[];
  personalNotes: string;
  isFinal: boolean;
}): string => {
  const parts = partialNotes
    .map((notes, index) => `<part number="${index + 1}">\n${notes}\n</part>`)
    .join("\n\n");
  const instructions = isFinal
    ? `Combine these notes from consecutive parts of one meeting into a single set of notes. Merge repeated topics and keep every decision and action item.

${NOTES_FORMAT}`
    : `Combine these notes from consecutive parts of one meeting into one shorter set of notes. Merge repeated topics and keep every decision and action item. Use markdown bullet points under short "###" topic headings.`;
  return `${instructions}

${personalNotesBlock(personalNotes)}${parts}`;
};

export const buildNoteTitlePrompt = (source: string): string =>
  `Write a short, specific title of at most eight words for this meeting, in its language. Reply with the title only.

<meeting>
${source.slice(0, TITLE_SOURCE_CHARS)}
</meeting>`;

/** Strips wrapping code fences that some models add around markdown. */
export const cleanGeneratedMarkdown = (text: string): string => {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
};

export const cleanGeneratedTitle = (text: string): string => {
  const firstLine =
    text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  const cleaned = firstLine
    .replace(/^(?:#+\s*|title:\s*)/i, "")
    .replace(/^["'“”‘’*_`]+|["'“”‘’*_`]+$/g, "")
    .replace(/[.。]+$/, "")
    .trim();
  return cleaned.length > MAX_TITLE_CHARS
    ? `${cleaned.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`
    : cleaned;
};

const generateMarkdown = async (
  generator: NoteTextGenerator,
  prompt: string,
): Promise<string> => {
  const output = await generator.generateText({
    system: NOTES_SYSTEM_PROMPT,
    prompt,
  });
  return cleanGeneratedMarkdown(output.text);
};

/**
 * Markdown notes for a transcript. Long transcripts are summarized part by
 * part and the partial notes combined (repeatedly, if they are still too long
 * for one call).
 */
export const generateNoteMarkdown = async ({
  generator,
  transcript,
  personalNotes,
}: {
  generator: NoteTextGenerator;
  transcript: string;
  personalNotes: string;
}): Promise<string> => {
  const parts = splitTextIntoChunks(transcript, NOTE_GENERATION_CHUNK_CHARS);
  if (parts.length <= 1) {
    return generateMarkdown(
      generator,
      buildNotesPrompt({ transcript: parts[0] ?? "", personalNotes }),
    );
  }

  let partialNotes: string[] = [];
  for (const [index, part] of parts.entries()) {
    partialNotes.push(
      await generateMarkdown(
        generator,
        buildPartialNotesPrompt({
          transcript: part,
          personalNotes,
          part: index + 1,
          partCount: parts.length,
        }),
      ),
    );
  }

  while (partialNotes.join("\n\n").length > NOTE_GENERATION_CHUNK_CHARS) {
    const groups: string[][] = [];
    let group: string[] = [];
    let groupChars = 0;
    for (const notes of partialNotes) {
      if (
        group.length > 0 &&
        groupChars + notes.length > NOTE_GENERATION_CHUNK_CHARS
      ) {
        groups.push(group);
        group = [];
        groupChars = 0;
      }
      group.push(notes);
      groupChars += notes.length;
    }
    groups.push(group);
    if (groups.length === partialNotes.length) {
      break;
    }

    const combined: string[] = [];
    for (const notes of groups) {
      combined.push(
        notes.length === 1
          ? notes[0]
          : await generateMarkdown(
              generator,
              buildCombineNotesPrompt({
                partialNotes: notes,
                personalNotes,
                isFinal: false,
              }),
            ),
      );
    }
    partialNotes = combined;
  }

  return generateMarkdown(
    generator,
    buildCombineNotesPrompt({ partialNotes, personalNotes, isFinal: true }),
  );
};

export const generateNoteTitle = async ({
  generator,
  source,
}: {
  generator: NoteTextGenerator;
  source: string;
}): Promise<string> => {
  const output = await generator.generateText({
    prompt: buildNoteTitlePrompt(source),
  });
  return cleanGeneratedTitle(output.text);
};

const ASK_SYSTEM_PROMPT = [
  "You answer questions about the user's meeting notes.",
  "Use only the numbered sources provided; never invent facts.",
  "Cite the sources you use inline as [1], [2] by their numbers.",
  "If the sources do not contain the answer, say so briefly.",
  "Answer concisely in markdown, in the language of the question.",
].join(" ");

export const buildAskMessages = ({
  question,
  passages,
  sourceNoteIds,
  history,
}: {
  question: string;
  passages: NoteAskPassage[];
  sourceNoteIds: string[];
  history: { role: "user" | "assistant"; content: string }[];
}): LlmMessage[] => {
  const context = sourceNoteIds
    .map((noteId, index) => {
      const notePassages = passages.filter(
        (passage) => passage.noteId === noteId,
      );
      const first = notePassages[0];
      return `<source number="${index + 1}" title="${first?.title ?? ""}" date="${first?.createdAt.slice(0, 10) ?? ""}">
${notePassages.map((passage) => passage.text).join("\n…\n")}
</source>`;
    })
    .join("\n\n");

  return [
    { role: "system", content: ASK_SYSTEM_PROMPT },
    ...history.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    {
      role: "user",
      content: `${context || "There are no sources."}

Question: ${question}`,
    },
  ];
};
