import { describe, expect, it } from "vitest";
import {
  mergeTranscriptions,
  splitAudioTranscription,
} from "./transcribe.utils";

describe("mergeTranscriptions", () => {
  describe("basic overlap detection", () => {
    it("should merge transcriptions with overlapping words", () => {
      const result = mergeTranscriptions([
        "I want to eat",
        "to eat milk and cookies",
      ]);
      expect(result).toBe("I want to eat milk and cookies");
    });

    it("should merge with single word overlap", () => {
      const result = mergeTranscriptions(["hello world", "world peace"]);
      expect(result).toBe("hello world peace");
    });

    it("should merge with longer overlap", () => {
      const result = mergeTranscriptions([
        "the quick brown fox",
        "quick brown fox jumps over",
      ]);
      expect(result).toBe("the quick brown fox jumps over");
    });
  });

  describe("no overlap - simple concatenation", () => {
    it("should concatenate when no overlap exists", () => {
      const result = mergeTranscriptions(["I want to", "eat milk"]);
      expect(result).toBe("I want to eat milk");
    });

    it("should concatenate completely different transcriptions", () => {
      const result = mergeTranscriptions(["hello there", "goodbye friend"]);
      expect(result).toBe("hello there goodbye friend");
    });
  });

  describe("multiple transcriptions", () => {
    it("should merge three transcriptions with overlaps", () => {
      const result = mergeTranscriptions(["a b c", "b c d", "c d e"]);
      expect(result).toBe("a b c d e");
    });

    it("should handle mixed overlap and no-overlap", () => {
      const result = mergeTranscriptions([
        "hello world",
        "world peace",
        "is important",
      ]);
      expect(result).toBe("hello world peace is important");
    });

    it("should merge four transcriptions correctly", () => {
      const result = mergeTranscriptions([
        "I want to",
        "want to eat",
        "to eat some",
        "eat some food",
      ]);
      expect(result).toBe("I want to eat some food");
    });
  });

  describe("edge cases", () => {
    it("should return empty string for empty array", () => {
      const result = mergeTranscriptions([]);
      expect(result).toBe("");
    });

    it("should return the single item for single-element array", () => {
      const result = mergeTranscriptions(["hello world"]);
      expect(result).toBe("hello world");
    });

    it("should handle empty string in array", () => {
      const result = mergeTranscriptions(["", "hello world"]);
      expect(result).toBe("hello world");
    });

    it("should handle empty string at end", () => {
      const result = mergeTranscriptions(["hello world", ""]);
      expect(result).toBe("hello world");
    });

    it("should handle empty strings in middle", () => {
      const result = mergeTranscriptions(["hello", "", "world"]);
      expect(result).toBe("hello world");
    });

    it("should handle all empty strings", () => {
      const result = mergeTranscriptions(["", "", ""]);
      expect(result).toBe("");
    });

    it("should handle whitespace-only strings", () => {
      const result = mergeTranscriptions(["  ", "hello", "   "]);
      expect(result).toBe("hello");
    });
  });

  describe("case insensitivity", () => {
    it("should match words case-insensitively", () => {
      const result = mergeTranscriptions(["I want TO eat", "to eat milk"]);
      expect(result).toBe("I want TO eat milk");
    });

    it("should preserve case from first transcription", () => {
      const result = mergeTranscriptions(["Hello World", "world peace"]);
      expect(result).toBe("Hello World peace");
    });

    it("should handle mixed case overlaps", () => {
      const result = mergeTranscriptions([
        "THE QUICK brown",
        "Brown FOX jumps",
      ]);
      expect(result).toBe("THE QUICK brown FOX jumps");
    });
  });

  describe("punctuation handling", () => {
    it("should match words with different punctuation", () => {
      const result = mergeTranscriptions([
        "I want to eat.",
        "to eat, milk and cookies",
      ]);
      expect(result).toBe("I want to eat. milk and cookies");
    });

    it("should handle question marks and exclamation points", () => {
      const result = mergeTranscriptions(["how are you?", "you! I am fine"]);
      expect(result).toBe("how are you? I am fine");
    });

    it("should handle quotes in words", () => {
      const result = mergeTranscriptions(['he said "hello', 'hello world"']);
      expect(result).toBe('he said "hello world"');
    });

    it("should match apostrophe words with non-apostrophe versions", () => {
      // "that's" without apostrophe becomes "thats" which should match
      const result = mergeTranscriptions([
        "I think that's great",
        "thats great and wonderful",
      ]);
      expect(result).toBe("I think that's great and wonderful");
    });

    it("should handle possessives with apostrophes", () => {
      const result = mergeTranscriptions([
        "the dog's toy is",
        "dogs toy is broken",
      ]);
      expect(result).toBe("the dog's toy is broken");
    });

    it("should handle multiple punctuation marks", () => {
      const result = mergeTranscriptions([
        "wait... what?!",
        "what?! that's crazy",
      ]);
      expect(result).toBe("wait... what?! that's crazy");
    });

    it("should handle punctuation mismatches in overlap", () => {
      const result = mergeTranscriptions([
        "Hello, world!!!",
        "world how are you?",
      ]);
      expect(result.toLowerCase()).toBe("hello, world!!! how are you?");
    });
  });

  describe("contraction handling", () => {
    it("should match contraction with expanded form (that's / that is)", () => {
      const result = mergeTranscriptions([
        "I think that's really",
        "that is really cool",
      ]);
      expect(result).toBe("I think that is really cool");
    });

    it("should match contraction with expanded form (don't / do not)", () => {
      const result = mergeTranscriptions([
        "I don't want to",
        "do not want to go",
      ]);
      expect(result).toBe("I do not want to go");
    });

    it("should match contraction with expanded form (I'm / I am)", () => {
      const result = mergeTranscriptions([
        "I'm going to the",
        "I am going to the store",
      ]);
      expect(result).toBe("I am going to the store");
    });

    it("should match contraction with expanded form (it's / it is)", () => {
      const result = mergeTranscriptions([
        "I think it's going",
        "it is going to rain",
      ]);
      expect(result).toBe("I think it is going to rain");
    });

    it("should match contraction with expanded form (we're / we are)", () => {
      const result = mergeTranscriptions([
        "we're going to be",
        "we are going to be late",
      ]);
      expect(result).toBe("we are going to be late");
    });

    it("should match contraction with expanded form (they're / they are)", () => {
      const result = mergeTranscriptions([
        "I think they're coming",
        "they are coming over tonight",
      ]);
      expect(result).toBe("I think they are coming over tonight");
    });

    it("should handle can't / cannot", () => {
      const result = mergeTranscriptions([
        "I can't believe that",
        "cannot believe that happened",
      ]);
      expect(result).toBe("I cannot believe that happened");
    });

    it("should handle there's / there is", () => {
      const result = mergeTranscriptions([
        "I think there's something",
        "there is something wrong",
      ]);
      expect(result).toBe("I think there is something wrong");
    });
  });

  describe("complete overlap scenarios", () => {
    it("should handle when second is fully contained in overlap", () => {
      const result = mergeTranscriptions(["hello world", "world"]);
      expect(result).toBe("hello world");
    });

    it("should handle identical transcriptions", () => {
      const result = mergeTranscriptions(["hello world", "hello world"]);
      expect(result).toBe("hello world");
    });

    it("should handle when first is prefix of second", () => {
      const result = mergeTranscriptions(["hello", "hello world"]);
      expect(result).toBe("hello world");
    });
  });

  describe("whitespace handling", () => {
    it("should handle extra whitespace between words", () => {
      // Note: whitespace is normalized during merge
      const result = mergeTranscriptions(["hello   world", "world  peace"]);
      expect(result).toBe("hello world peace");
    });

    it("should handle leading and trailing whitespace", () => {
      const result = mergeTranscriptions([
        "  hello world  ",
        "  world peace  ",
      ]);
      expect(result).toBe("hello world peace");
    });

    it("should handle tabs and newlines", () => {
      // Note: whitespace is normalized during merge
      const result = mergeTranscriptions(["hello\tworld", "world\npeace"]);
      expect(result).toBe("hello world peace");
    });
  });

  describe("hyphenated word handling", () => {
    it("should detect overlap despite hyphen differences", () => {
      // Transcribers sometimes produce "slow-moving" and sometimes "slow moving"
      // The overlap is detected using fuzzy matching
      const result = mergeTranscriptions([
        "turning dust into slow-moving constellations",
        "slow moving constellations and making the room",
      ]);
      // Uses second segment's version for the overlap region
      expect(result).toBe(
        "turning dust into slow moving constellations and making the room",
      );
    });

    it("should handle hyphenated word in second segment", () => {
      const result = mergeTranscriptions([
        "the well known scientist",
        "well-known scientist discovered",
      ]);
      // Uses second segment's version for fuzzy overlap
      expect(result).toBe("the well-known scientist discovered");
    });

    it("should detect overlap with hyphenated words", () => {
      const result = mergeTranscriptions([
        "a self-driving car in the",
        "self driving car in the city",
      ]);
      // Uses second segment's version for the overlap region
      expect(result).toBe("a self driving car in the city");
    });

    it("should handle real transcript with inconsistent hyphens", () => {
      const result = mergeTranscriptions([
        "making the room feel briefly weightless.",
        "feel briefly weightless there's somewhere outside",
      ]);
      expect(result).toBe(
        "making the room feel briefly weightless there's somewhere outside",
      );
    });
  });

  describe("truncated word handling", () => {
    it("should handle truncated last word by preferring second segment's version", () => {
      // When audio is cut mid-word, the transcriber might mishear the partial word
      // e.g., "bagels" cut mid-word might be transcribed as "big"
      const result = mergeTranscriptions([
        "hello i like big",
        "like bagels a lot",
      ]);
      expect(result).toBe("hello i like bagels a lot");
    });

    it("should handle truncated word with longer overlap", () => {
      // "going to the sto" might be transcribed as "going to the stuff" or similar
      const result = mergeTranscriptions([
        "I was going to the sto",
        "to the store tomorrow",
      ]);
      expect(result).toBe("I was going to the store tomorrow");
    });

    it("should handle truncated word with single word overlap", () => {
      const result = mergeTranscriptions(["hello wor", "world peace"]);
      expect(result).toBe("hello world peace");
    });

    it("should prefer exact match over truncated match when available", () => {
      // When there's an exact overlap, use it instead of truncated logic
      const result = mergeTranscriptions([
        "hello world peace",
        "world peace and love",
      ]);
      expect(result).toBe("hello world peace and love");
    });

    it("should handle truncated word at segment boundary in multi-segment merge", () => {
      const result = mergeTranscriptions([
        "the quick bro",
        "brown fox jumps",
        "fox jumps over",
      ]);
      expect(result).toBe("the quick brown fox jumps over");
    });
  });

  describe("realistic transcription scenarios", () => {
    it("should merge realistic speech segments", () => {
      const result = mergeTranscriptions([
        "So I was thinking about going to the",
        "going to the store tomorrow",
        "the store tomorrow and picking up some groceries",
      ]);
      expect(result).toBe(
        "So I was thinking about going to the store tomorrow and picking up some groceries",
      );
    });

    it("should handle partial sentence overlaps", () => {
      const result = mergeTranscriptions([
        "The weather today is really",
        "is really nice and sunny",
        "nice and sunny outside",
      ]);
      expect(result).toBe("The weather today is really nice and sunny outside");
    });

    it("should handle technical speech with numbers", () => {
      const result = mergeTranscriptions([
        "The value is 42 and",
        "42 and the result is",
        "the result is 100",
      ]);
      expect(result).toBe("The value is 42 and the result is 100");
    });
  });
});

describe("splitAudioTranscription", () => {
  // Helper to create a Float32Array with sequential values for easy verification
  const createSamples = (length: number): Float32Array => {
    const samples = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      samples[i] = i;
    }
    return samples;
  };

  describe("basic splitting", () => {
    it("should split audio into overlapping segments", () => {
      // 10 samples, 4-sample segments, 2-sample overlap (step = 2)
      // Expected: [0,1,2,3], [2,3,4,5], [4,5,6,7], [6,7,8,9]
      const samples = createSamples(10);
      const result = splitAudioTranscription({
        sampleRate: 1,
        samples,
        segmentDurationSec: 4,
        overlapDurationSec: 2,
      });

      expect(result).toHaveLength(4);
      expect(Array.from(result[0])).toEqual([0, 1, 2, 3]);
      expect(Array.from(result[1])).toEqual([2, 3, 4, 5]);
      expect(Array.from(result[2])).toEqual([4, 5, 6, 7]);
      expect(Array.from(result[3])).toEqual([6, 7, 8, 9]);
    });

    it("should handle no overlap (step equals segment size)", () => {
      // 8 samples, 4-sample segments, 0 overlap (step = 4)
      // Expected: [0,1,2,3], [4,5,6,7]
      const samples = createSamples(8);
      const result = splitAudioTranscription({
        sampleRate: 1,
        samples,
        segmentDurationSec: 4,
        overlapDurationSec: 0,
      });

      expect(result).toHaveLength(2);
      expect(Array.from(result[0])).toEqual([0, 1, 2, 3]);
      expect(Array.from(result[1])).toEqual([4, 5, 6, 7]);
    });

    it("should use sample rate to calculate segment size", () => {
      // 16000 samples = 1 second at 16kHz
      // 4-second segments at 16kHz = 64000 samples per segment
      // With 2-second overlap, step = 2 seconds = 32000 samples
      const sampleRate = 16000;
      const samples = createSamples(sampleRate * 5); // 5 seconds of audio

      const result = splitAudioTranscription({
        sampleRate,
        samples,
        segmentDurationSec: 4,
        overlapDurationSec: 2,
      });

      // 5 sec audio, 4 sec segments, 2 sec step
      // Segment 1: 0-4s, Segment 2: 2-5s (truncated)
      expect(result).toHaveLength(2);
      expect(result[0].length).toBe(sampleRate * 4); // Full 4 seconds
      expect(result[1].length).toBe(sampleRate * 3); // 3 seconds (2-5s)
    });
  });

  describe("edge cases", () => {
    it("should return single segment when audio is shorter than segment duration", () => {
      const samples = createSamples(3);
      const result = splitAudioTranscription({
        sampleRate: 1,
        samples,
        segmentDurationSec: 4,
        overlapDurationSec: 2,
      });

      expect(result).toHaveLength(1);
      expect(Array.from(result[0])).toEqual([0, 1, 2]);
    });

    it("should return single segment when audio equals segment duration", () => {
      const samples = createSamples(4);
      const result = splitAudioTranscription({
        sampleRate: 1,
        samples,
        segmentDurationSec: 4,
        overlapDurationSec: 2,
      });

      expect(result).toHaveLength(1);
      expect(Array.from(result[0])).toEqual([0, 1, 2, 3]);
    });

    it("should handle last segment being shorter than full segment", () => {
      // 9 samples, 4-sample segments, 2-sample overlap (step = 2)
      // Expected: [0,1,2,3], [2,3,4,5], [4,5,6,7], [6,7,8] (last is truncated)
      const samples = createSamples(9);
      const result = splitAudioTranscription({
        sampleRate: 1,
        samples,
        segmentDurationSec: 4,
        overlapDurationSec: 2,
      });

      expect(result).toHaveLength(4);
      expect(Array.from(result[3])).toEqual([6, 7, 8]);
    });

    it("should handle empty samples array", () => {
      const samples = new Float32Array(0);
      const result = splitAudioTranscription({
        sampleRate: 1,
        samples,
        segmentDurationSec: 4,
        overlapDurationSec: 2,
      });

      expect(result).toHaveLength(1);
      expect(result[0].length).toBe(0);
    });
  });

  describe("error handling", () => {
    it("should throw when overlap equals segment duration", () => {
      const samples = createSamples(10);
      expect(() =>
        splitAudioTranscription({
          sampleRate: 1,
          samples,
          segmentDurationSec: 4,
          overlapDurationSec: 4,
        }),
      ).toThrow("Overlap duration must be less than segment duration");
    });

    it("should throw when overlap exceeds segment duration", () => {
      const samples = createSamples(10);
      expect(() =>
        splitAudioTranscription({
          sampleRate: 1,
          samples,
          segmentDurationSec: 4,
          overlapDurationSec: 5,
        }),
      ).toThrow("Overlap duration must be less than segment duration");
    });
  });

  describe("realistic scenarios", () => {
    it("should correctly split 30 seconds of audio at 16kHz with 10s segments and 3s overlap", () => {
      const sampleRate = 16000;
      const durationSec = 30;
      const samples = createSamples(sampleRate * durationSec);

      const result = splitAudioTranscription({
        sampleRate,
        samples,
        segmentDurationSec: 10,
        overlapDurationSec: 3,
      });

      // Step = 10 - 3 = 7 seconds
      // Segments: 0-10, 7-17, 14-24, 21-30 (truncated)
      expect(result).toHaveLength(4);
      expect(result[0].length).toBe(sampleRate * 10);
      expect(result[1].length).toBe(sampleRate * 10);
      expect(result[2].length).toBe(sampleRate * 10);
      expect(result[3].length).toBe(sampleRate * 9); // 21-30 = 9 seconds
    });

    it("should correctly split 60 seconds of audio with 4s segments and 2s overlap", () => {
      const sampleRate = 16000;
      const durationSec = 60;
      const samples = createSamples(sampleRate * durationSec);

      const result = splitAudioTranscription({
        sampleRate,
        samples,
        segmentDurationSec: 4,
        overlapDurationSec: 2,
      });

      // Step = 4 - 2 = 2 seconds
      // Number of full steps: (60 - 4) / 2 = 28, plus initial = 29 segments
      expect(result).toHaveLength(29);

      // Verify first segment starts at 0
      expect(result[0][0]).toBe(0);

      // Verify second segment starts at step (2 seconds = 32000 samples)
      expect(result[1][0]).toBe(sampleRate * 2);

      // Verify last segment
      expect(result[28][0]).toBe(sampleRate * 56); // 28 * 2 = 56 seconds
    });
  });
});
