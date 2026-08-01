import { Nullable } from "@voquill/types";

/**
 * Calculates the Levenshtein edit distance between two strings.
 * Returns the minimum number of single-character edits (insertions,
 * deletions, or substitutions) required to change one string into the other.
 */
export const editDistance = (a: string, b: string): number => {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Use two rows instead of full matrix for space efficiency
  let prevRow = Array.from({ length: b.length + 1 }, (_, i) => i);
  // oxlint-disable-next-line no-new-array
  let currRow = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    currRow[0] = i;

    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        currRow[j - 1]! + 1, // insertion
        prevRow[j]! + 1, // deletion
        prevRow[j - 1]! + cost, // substitution
      );
    }

    [prevRow, currRow] = [currRow, prevRow];
  }

  return prevRow[b.length]!;
};

/**
 * Calculates the similarity between two strings as a ratio from 0 to 1.
 * Returns 1 for identical strings, 0 for completely different strings.
 * Based on Levenshtein edit distance.
 */
export const getStringSimilarity = (a: string, b: string): number => {
  if (a.length === 0 && b.length === 0) return 1;

  const maxLength = Math.max(a.length, b.length);
  const distance = editDistance(a, b);

  return (maxLength - distance) / maxLength;
};

export const getFirstAndLastName = (
  fullName: string,
): {
  firstName: Nullable<string>;
  lastName: Nullable<string>;
} => {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) {
    return { firstName: null, lastName: null };
  }

  const firstName = parts[0];
  const lastName = parts.length > 1 ? parts.at(-1) : null;
  return {
    firstName: firstName.trim() || null,
    lastName: lastName?.trim() || null,
  };
};

export const getInitials = (fullName: string): string => {
  const { firstName, lastName } = getFirstAndLastName(fullName);
  if (!firstName && !lastName) return "";
  if (firstName && !lastName) return firstName.charAt(0).toUpperCase();
  if (!firstName && lastName) return lastName.charAt(0).toUpperCase();
  return (
    (firstName ? firstName.charAt(0).toUpperCase() : "") +
    (lastName ? lastName.charAt(0).toUpperCase() : "")
  );
};

export type ReplacementRule = {
  sourceValue: string;
  destinationValue: string;
};

const SYMBOL_CONVERSIONS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bhashtag[,;:.!?]?\s+(\w)/gi, replacement: "#$1" },
  { pattern: /\bpound\s*sign[,;:.!?]?\s+(\w)/gi, replacement: "#$1" },
];

export const applySymbolConversions = (text: string): string => {
  let result = text;

  for (const { pattern, replacement } of SYMBOL_CONVERSIONS) {
    result = result.replace(pattern, replacement);
  }

  return result;
};

const SIMILARITY_THRESHOLD = 0.95;

const extractPunctuation = (
  word: string,
): {
  word: string;
  leadingPunctuation: string;
  trailingPunctuation: string;
} => {
  const leadingMatch = word.match(/^([^\p{L}\p{N}]*)/u);
  const leadingPunctuation = leadingMatch?.[1] ?? "";

  const afterLeading = word.slice(leadingPunctuation.length);

  const trailingMatch = afterLeading.match(/('s)?([^\p{L}\p{N}]*)$/iu);
  const possessiveSuffix = trailingMatch?.[1] ?? "";
  const trailingPunctuation = possessiveSuffix + (trailingMatch?.[2] ?? "");

  const wordOnly = afterLeading.slice(
    0,
    afterLeading.length - trailingPunctuation.length || undefined,
  );

  return { word: wordOnly, leadingPunctuation, trailingPunctuation };
};

export const sanitizeIndentation = (text: string): string => {
  return text
    .split("\n")
    .map((line) => line.trimStart())
    .join("\n");
};

const collapseWhitespace = (text: string): string => text.replace(/\s+/g, " ");

/**
 * Canonical form used to compare a rule's source against a candidate span:
 * internal whitespace collapsed, surrounding punctuation stripped.
 */
const normalizePhrase = (phrase: string): string =>
  extractPunctuation(collapseWhitespace(phrase.trim())).word;

const countWords = (phrase: string): number => {
  const trimmed = phrase.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
};

export const applyReplacements = (
  text: string,
  rules: ReplacementRule[],
): string => {
  if (rules.length === 0) return text;

  const segments = text.split(/(\s+)/);

  // Positions of the word segments; the odd indices in between are whitespace.
  const wordPositions: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment && !/^\s+$/.test(segment)) {
      wordPositions.push(i);
    }
  }

  // Rules are matched as phrases, so a rule spans as many words as its source
  // does. Longer phrases are tried first so that "New York City" wins over a
  // "New York" rule at the same position.
  const preparedRules = rules
    .map((rule) => ({
      rule,
      source: normalizePhrase(rule.sourceValue).toLowerCase(),
      wordCount: countWords(rule.sourceValue),
    }))
    .filter((prepared) => prepared.source.length > 0);

  if (preparedRules.length === 0) return text;

  const maxWordCount = Math.max(
    ...preparedRules.map((prepared) => prepared.wordCount),
  );

  const result: string[] = [];
  let segmentIndex = 0;
  let wordIndex = 0;

  while (wordIndex < wordPositions.length) {
    const startSegment = wordPositions[wordIndex];

    // Emit whitespace (and anything else) preceding this word untouched.
    while (segmentIndex < startSegment) {
      result.push(segments[segmentIndex]);
      segmentIndex++;
    }

    const remainingWords = wordPositions.length - wordIndex;
    let matched = false;

    for (
      let span = Math.min(maxWordCount, remainingWords);
      span >= 1 && !matched;
      span--
    ) {
      const endSegment = wordPositions[wordIndex + span - 1];
      const candidate = segments.slice(startSegment, endSegment + 1).join("");
      const { word, leadingPunctuation, trailingPunctuation } =
        extractPunctuation(candidate);

      if (!word) continue;

      const normalizedCandidate = collapseWhitespace(word).toLowerCase();

      let bestMatch: ReplacementRule | null = null;
      let bestSimilarity = 0;

      for (const prepared of preparedRules) {
        if (prepared.wordCount !== span) continue;

        const similarity = getStringSimilarity(
          normalizedCandidate,
          prepared.source,
        );
        if (similarity >= SIMILARITY_THRESHOLD && similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestMatch = prepared.rule;
        }
      }

      if (bestMatch) {
        const { word: destinationWord } = extractPunctuation(
          bestMatch.destinationValue,
        );
        result.push(leadingPunctuation + destinationWord + trailingPunctuation);
        segmentIndex = endSegment + 1;
        wordIndex += span;
        matched = true;
      }
    }

    if (!matched) {
      result.push(segments[startSegment]);
      segmentIndex = startSegment + 1;
      wordIndex++;
    }
  }

  // Emit any trailing whitespace.
  while (segmentIndex < segments.length) {
    result.push(segments[segmentIndex]);
    segmentIndex++;
  }

  return result.join("");
};
