import { getStringSimilarity } from "./string.utils";

/**
 * Normalizes text for comparison by removing punctuation, hyphens, and lowercasing.
 * This creates a canonical form for fuzzy matching.
 */
const normalizeText = (text: string): string => {
  return text
    .toLowerCase()
    .replace(/[.,!?;:'"()[\]{}-]/g, "") // Remove punctuation including hyphens
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim();
};

/** Minimum similarity threshold for considering two text segments as matching */
const SIMILARITY_THRESHOLD = 0.75;

/**
 * Result of finding overlap between two transcriptions.
 * - wordsToKeepFromFirst: number of words to keep from first transcription
 * - wordsToSkipFromSecond: number of words to skip from start of second transcription
 */
type OverlapResult = {
  wordsToKeepFromFirst: number;
  wordsToSkipFromSecond: number;
};

/** Threshold for considering a match "exact" (same word count, very high similarity) */
const EXACT_MATCH_THRESHOLD = 0.9;

/**
 * Finds the best overlap between two transcriptions using fuzzy string matching.
 * This handles contractions ("that's" vs "that is"), hyphens ("slow-moving" vs "slow moving"),
 * punctuation differences, and minor transcription errors.
 */
const findOverlap = (first: string, second: string): OverlapResult => {
  const firstWords = first.trim().split(/\s+/);
  const secondWords = second.trim().split(/\s+/);

  if (firstWords.length === 0 || secondWords.length === 0) {
    return {
      wordsToKeepFromFirst: firstWords.length,
      wordsToSkipFromSecond: 0,
    };
  }

  // Allow different limits for first and second to handle contraction expansion
  // e.g., "I'm" (1 word) needs to match "I am" (2 words)
  // Use higher limit (30 words) for longer audio segment overlaps
  const maxIToCheck = Math.min(firstWords.length, 30);
  const maxJToCheck = Math.min(secondWords.length, 30);

  // Track best overlap found
  let best: {
    i: number; // words from end of first
    j: number; // words from start of second
    similarity: number;
    isExact: boolean;
  } | null = null;

  // For each possible overlap size
  for (let i = 1; i <= maxIToCheck; i++) {
    const endOfFirst = firstWords.slice(-i).join(" ");
    const normalizedFirst = normalizeText(endOfFirst);

    for (let j = 1; j <= maxJToCheck; j++) {
      const startOfSecond = secondWords.slice(0, j).join(" ");
      const normalizedSecond = normalizeText(startOfSecond);

      // Skip if lengths are too different
      const lengthRatio =
        Math.min(normalizedFirst.length, normalizedSecond.length) /
        Math.max(normalizedFirst.length, normalizedSecond.length);
      if (lengthRatio < 0.5) continue;

      const similarity = getStringSimilarity(normalizedFirst, normalizedSecond);

      if (similarity >= SIMILARITY_THRESHOLD) {
        const isExact = i === j && similarity >= EXACT_MATCH_THRESHOLD;

        // Prefer: longer overlaps (j), then exact matches, then higher similarity
        const score = j * 10 + (isExact ? 5 : 0) + similarity;
        const bestScore = best
          ? best.j * 10 + (best.isExact ? 5 : 0) + best.similarity
          : 0;

        if (!best || score > bestScore) {
          best = { i, j, similarity, isExact };
        }
      }
    }
  }

  // Check if last word of first is a truncated prefix of first word of second
  // e.g., "hello wor" + "world peace" → "wor" is prefix of "world"
  if (secondWords.length > 0) {
    const lastWordOfFirst = normalizeText(firstWords[firstWords.length - 1]);
    const firstWordOfSecond = normalizeText(secondWords[0]);

    if (
      lastWordOfFirst.length >= 2 &&
      firstWordOfSecond.startsWith(lastWordOfFirst) &&
      lastWordOfFirst.length < firstWordOfSecond.length
    ) {
      // Drop the truncated word from first, use all of second
      return {
        wordsToKeepFromFirst: firstWords.length - 1,
        wordsToSkipFromSecond: 0,
      };
    }
  }

  // Also check for overlap if we drop the last word (handles truncated/misheard last word)
  if (!best && firstWords.length >= 2) {
    const firstWithoutLast = firstWords.slice(0, -1);
    for (let i = 1; i <= Math.min(firstWithoutLast.length, 30); i++) {
      const endOfFirst = firstWithoutLast.slice(-i).join(" ");
      const normalizedFirst = normalizeText(endOfFirst);

      for (let j = 1; j <= maxJToCheck; j++) {
        const startOfSecond = secondWords.slice(0, j).join(" ");
        const normalizedSecond = normalizeText(startOfSecond);

        const lengthRatio =
          Math.min(normalizedFirst.length, normalizedSecond.length) /
          Math.max(normalizedFirst.length, normalizedSecond.length);
        if (lengthRatio < 0.5) continue;

        const similarity = getStringSimilarity(
          normalizedFirst,
          normalizedSecond,
        );

        if (similarity >= EXACT_MATCH_THRESHOLD && i === j) {
          // Found exact match after dropping last word - keep first without last word, skip overlap from second
          return {
            wordsToKeepFromFirst: firstWords.length - 1,
            wordsToSkipFromSecond: j,
          };
        }
      }
    }
  }

  // No overlap found - concatenate
  if (!best) {
    return {
      wordsToKeepFromFirst: firstWords.length,
      wordsToSkipFromSecond: 0,
    };
  }

  // Exact match: keep all of first (preserving its formatting), skip overlap from second
  if (best.isExact) {
    return {
      wordsToKeepFromFirst: firstWords.length,
      wordsToSkipFromSecond: best.j,
    };
  }

  // Fuzzy match: drop the overlapping portion from first, use second's version
  // This handles contractions, hyphens, and truncated words
  return {
    wordsToKeepFromFirst: firstWords.length - best.i,
    wordsToSkipFromSecond: 0,
  };
};

/**
 * Merges two transcriptions by finding overlap using fuzzy string matching.
 * Handles contractions, hyphens, punctuation differences, and minor errors.
 */
const mergeTwoTranscriptions = (first: string, second: string): string => {
  const trimmedFirst = first.trim();
  const trimmedSecond = second.trim();

  if (!trimmedFirst) return trimmedSecond;
  if (!trimmedSecond) return trimmedFirst;

  const firstWords = trimmedFirst.split(/\s+/);
  const secondWords = trimmedSecond.split(/\s+/);

  const { wordsToKeepFromFirst, wordsToSkipFromSecond } = findOverlap(
    trimmedFirst,
    trimmedSecond,
  );

  // Build the merged result
  const firstPart = firstWords.slice(0, wordsToKeepFromFirst).join(" ");
  const secondPart = secondWords.slice(wordsToSkipFromSecond).join(" ");

  if (!firstPart) return trimmedSecond;
  if (!secondPart) return firstPart;

  return `${firstPart} ${secondPart}`;
};

/**
 * Merges multiple transcriptions from overlapping audio segments into a single string.
 *
 * The algorithm detects word overlap between consecutive transcriptions:
 * - If the end of one transcription matches the start of the next, they're merged at that point
 * - If no overlap is detected, transcriptions are concatenated with a space
 *
 * @example
 * // With overlap
 * mergeTranscriptions(["I want to eat", "to eat milk and cookies"])
 * // Returns: "I want to eat milk and cookies"
 *
 * @example
 * // Without overlap
 * mergeTranscriptions(["I want to", "eat milk"])
 * // Returns: "I want to eat milk"
 */
export const mergeTranscriptions = (transcriptions: string[]): string => {
  if (transcriptions.length === 0) return "";
  if (transcriptions.length === 1) return transcriptions[0];

  return transcriptions.reduce((merged, current) =>
    mergeTwoTranscriptions(merged, current),
  );
};

/**
 * Splits audio samples into overlapping segments for transcription.
 *
 * @example
 * // With 4 second segments and 2 second overlap:
 * // Segment 1: 0-4 sec
 * // Segment 2: 2-6 sec
 * // Segment 3: 4-8 sec
 * // etc.
 */
export const splitAudioTranscription = (args: {
  sampleRate: number;
  samples: Float32Array;
  segmentDurationSec: number;
  overlapDurationSec: number;
}): Float32Array[] => {
  const { sampleRate, samples, segmentDurationSec, overlapDurationSec } = args;

  const segmentSamples = Math.floor(sampleRate * segmentDurationSec);
  const stepSamples = Math.floor(
    sampleRate * (segmentDurationSec - overlapDurationSec),
  );

  if (stepSamples <= 0) {
    throw new Error("Overlap duration must be less than segment duration");
  }

  if (samples.length <= segmentSamples) {
    return [samples];
  }

  const segments: Float32Array[] = [];

  for (let start = 0; start < samples.length; start += stepSamples) {
    const end = Math.min(start + segmentSamples, samples.length);
    segments.push(samples.slice(start, end));

    if (end === samples.length) {
      break;
    }
  }

  return segments;
};
