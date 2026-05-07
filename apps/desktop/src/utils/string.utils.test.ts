import { describe, expect, it } from "vitest";
import {
  applyReplacements,
  applySymbolConversions,
  editDistance,
  getFirstAndLastName,
  getInitials,
  getStringSimilarity,
} from "./string.utils";

describe("editDistance", () => {
  it("should return 0 for identical strings", () => {
    expect(editDistance("hello", "hello")).toBe(0);
    expect(editDistance("", "")).toBe(0);
  });

  it("should return length of other string when one is empty", () => {
    expect(editDistance("", "hello")).toBe(5);
    expect(editDistance("hello", "")).toBe(5);
  });

  it("should return 1 for single character difference", () => {
    expect(editDistance("cat", "bat")).toBe(1); // substitution
    expect(editDistance("cat", "cats")).toBe(1); // insertion
    expect(editDistance("cats", "cat")).toBe(1); // deletion
  });

  it("should handle insertions", () => {
    expect(editDistance("ac", "abc")).toBe(1);
    expect(editDistance("abc", "abcd")).toBe(1);
  });

  it("should handle deletions", () => {
    expect(editDistance("abc", "ac")).toBe(1);
    expect(editDistance("abcd", "abc")).toBe(1);
  });

  it("should handle substitutions", () => {
    expect(editDistance("abc", "adc")).toBe(1);
    expect(editDistance("abc", "axc")).toBe(1);
  });

  it("should handle multiple edits", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("saturday", "sunday")).toBe(3);
  });

  it("should handle completely different strings", () => {
    expect(editDistance("abc", "xyz")).toBe(3);
    expect(editDistance("hello", "world")).toBe(4);
  });

  it("should be symmetric", () => {
    expect(editDistance("abc", "def")).toBe(editDistance("def", "abc"));
    expect(editDistance("kitten", "sitting")).toBe(
      editDistance("sitting", "kitten"),
    );
  });

  it("should handle case sensitivity", () => {
    expect(editDistance("Hello", "hello")).toBe(1);
    expect(editDistance("ABC", "abc")).toBe(3);
  });

  it("should handle whitespace differences", () => {
    expect(editDistance("slow moving", "slowmoving")).toBe(1);
    expect(editDistance("hello world", "helloworld")).toBe(1);
  });
});

describe("getStringSimilarity", () => {
  it("should return 1 for identical strings", () => {
    expect(getStringSimilarity("hello", "hello")).toBe(1);
    expect(getStringSimilarity("test", "test")).toBe(1);
  });

  it("should return 1 for two empty strings", () => {
    expect(getStringSimilarity("", "")).toBe(1);
  });

  it("should return 0 when one string is empty and other is not", () => {
    expect(getStringSimilarity("", "hello")).toBe(0);
    expect(getStringSimilarity("hello", "")).toBe(0);
  });

  it("should return correct similarity for single character difference", () => {
    // "hello" vs "hallo" = 1 edit, 5 chars max, similarity = 4/5 = 0.8
    expect(getStringSimilarity("hello", "hallo")).toBe(0.8);
  });

  it("should return correct similarity for multiple differences", () => {
    // "kitten" vs "sitting" = 3 edits, 7 chars max, similarity = 4/7
    expect(getStringSimilarity("kitten", "sitting")).toBeCloseTo(4 / 7);
  });

  it("should return 0 for completely different strings of same length", () => {
    expect(getStringSimilarity("abc", "xyz")).toBe(0);
  });

  it("should be symmetric", () => {
    expect(getStringSimilarity("abc", "def")).toBe(
      getStringSimilarity("def", "abc"),
    );
    expect(getStringSimilarity("hello", "world")).toBe(
      getStringSimilarity("world", "hello"),
    );
  });

  it("should handle high similarity strings", () => {
    // "slow moving" vs "slowmoving" = 1 edit, 11 chars max, similarity = 10/11
    const similarity = getStringSimilarity("slow moving", "slowmoving");
    expect(similarity).toBeCloseTo(10 / 11);
    expect(similarity).toBeGreaterThan(0.9);
  });

  it("should return value between 0 and 1", () => {
    const testCases = [
      ["a", "b"],
      ["hello", "world"],
      ["test", "testing"],
      ["abc", "abcdef"],
    ];

    for (const [a, b] of testCases) {
      const similarity = getStringSimilarity(a, b);
      expect(similarity).toBeGreaterThanOrEqual(0);
      expect(similarity).toBeLessThanOrEqual(1);
    }
  });
});

describe("getFirstAndLastName", () => {
  it("should return first and last name for a full name", () => {
    const result = getFirstAndLastName("John Doe");
    expect(result).toEqual({ firstName: "John", lastName: "Doe" });
  });

  it("should return only first name if no last name", () => {
    const result = getFirstAndLastName("John");
    expect(result).toEqual({ firstName: "John", lastName: null });
  });

  it("should handle names with multiple parts", () => {
    const result = getFirstAndLastName("John Michael Doe");
    expect(result).toEqual({ firstName: "John", lastName: "Doe" });
  });

  it("should handle leading and trailing spaces", () => {
    const result = getFirstAndLastName("  John Doe  ");
    expect(result).toEqual({ firstName: "John", lastName: "Doe" });
  });

  it("should return nulls for empty string", () => {
    const result = getFirstAndLastName("");
    expect(result).toEqual({ firstName: null, lastName: null });
  });

  it("should return nulls for string with only spaces", () => {
    const result = getFirstAndLastName("   ");
    expect(result).toEqual({ firstName: null, lastName: null });
  });

  it("should handle names with tabs and newlines", () => {
    const result = getFirstAndLastName("John\tDoe\nSmith");
    expect(result).toEqual({ firstName: "John", lastName: "Smith" });
  });
});

describe("getInitials", () => {
  it("should return initials for first and last name", () => {
    const result = getInitials("John Doe");
    expect(result).toBe("JD");
  });

  it("should return single initial for single name", () => {
    const result = getInitials("John");
    expect(result).toBe("J");
  });

  it("should return first and last initials for multiple names", () => {
    const result = getInitials("John Michael Doe");
    expect(result).toBe("JD");
  });

  it("should handle names with leading and trailing spaces", () => {
    const result = getInitials("  John Doe  ");
    expect(result).toBe("JD");
  });

  it("should return empty string for empty input", () => {
    const result = getInitials("");
    expect(result).toBe("");
  });

  it("should return empty string for string with only spaces", () => {
    const result = getInitials("   ");
    expect(result).toBe("");
  });

  it("should handle lowercase names and return uppercase initials", () => {
    const result = getInitials("john doe");
    expect(result).toBe("JD");
  });

  it("should handle names with special characters", () => {
    const result = getInitials("Jean-Luc Picard");
    expect(result).toBe("JP");
  });

  it("should handle names with tabs and newlines", () => {
    const result = getInitials("John\tDoe\nSmith");
    expect(result).toBe("JS");
  });
});

describe("applyReplacements", () => {
  it("should return original text when no rules provided", () => {
    expect(applyReplacements("hello world", [])).toBe("hello world");
  });

  it("should work for Rafa", () => {
    expect(
      applyReplacements("Rafa is great", [
        { sourceValue: "Rafa", destinationValue: "Rapha" },
      ]),
    ).toBe("Rapha is great");
    // "Raffa" vs "Rafa" is 80% similar (1 edit, 5 chars), below 95% threshold
    expect(
      applyReplacements("Raffa is great", [
        { sourceValue: "Rafa", destinationValue: "Rapha" },
      ]),
    ).toBe("Raffa is great");
    expect(
      applyReplacements("Paffa is great", [
        { sourceValue: "Rafa", destinationValue: "Rapha" },
      ]),
    ).toBe("Paffa is great");
    expect(
      applyReplacements("Rafa's is awesome.", [
        { sourceValue: "Rafa", destinationValue: "Rapha" },
      ]),
    ).toBe("Rapha's is awesome.");
  });

  it("should return original text when text is empty", () => {
    const rules = [{ sourceValue: "foo", destinationValue: "bar" }];
    expect(applyReplacements("", rules)).toBe("");
  });

  it("should replace exact matches", () => {
    const rules = [{ sourceValue: "LLM", destinationValue: "Claude" }];
    expect(applyReplacements("I use LLM daily", rules)).toBe(
      "I use Claude daily",
    );
  });

  it("should replace case-insensitive matches", () => {
    const rules = [{ sourceValue: "LLM", destinationValue: "Claude" }];
    expect(applyReplacements("I use llm daily", rules)).toBe(
      "I use Claude daily",
    );
  });

  it("should replace multiple occurrences", () => {
    const rules = [{ sourceValue: "foo", destinationValue: "bar" }];
    expect(applyReplacements("foo and foo and foo", rules)).toBe(
      "bar and bar and bar",
    );
  });

  it("should apply multiple different rules", () => {
    const rules = [
      { sourceValue: "LLM", destinationValue: "Claude" },
      { sourceValue: "JS", destinationValue: "JavaScript" },
    ];
    expect(applyReplacements("I use LLM and JS", rules)).toBe(
      "I use Claude and JavaScript",
    );
  });

  it("should preserve whitespace", () => {
    const rules = [{ sourceValue: "hello", destinationValue: "hi" }];
    expect(applyReplacements("  hello   world  ", rules)).toBe(
      "  hi   world  ",
    );
  });

  it("should preserve newlines and tabs", () => {
    const rules = [{ sourceValue: "foo", destinationValue: "bar" }];
    expect(applyReplacements("foo\nfoo\tfoo", rules)).toBe("bar\nbar\tbar");
  });

  it("should not replace words that are similar but below 95% threshold", () => {
    const rules = [{ sourceValue: "hello", destinationValue: "hi" }];
    // "hallo" is 80% similar to "hello" (1 edit, 5 chars), below 95% threshold
    expect(applyReplacements("hallo world", rules)).toBe("hallo world");
  });

  it("should not replace words below similarity threshold", () => {
    const rules = [{ sourceValue: "hello", destinationValue: "hi" }];
    // "help" is only 60% similar to "hello" (2 edits, 5 chars)
    expect(applyReplacements("help world", rules)).toBe("help world");
  });

  it("should choose best match when multiple rules could apply", () => {
    const rules = [
      { sourceValue: "test", destinationValue: "exam" },
      { sourceValue: "testing", destinationValue: "examining" },
    ];
    expect(applyReplacements("testing in progress", rules)).toBe(
      "examining in progress",
    );
  });

  it("should handle punctuation attached to words when rule includes punctuation", () => {
    // Rule punctuation is stripped for matching, input punctuation is preserved
    const rules = [{ sourceValue: "hello,", destinationValue: "hi," }];
    expect(applyReplacements("hello, world!", rules)).toBe("hi, world!");
  });

  it("should match words with punctuation via similarity", () => {
    const rules = [{ sourceValue: "hello", destinationValue: "hi" }];
    // "hello," vs "hello" is 5/6 = 83% similar, above threshold
    expect(applyReplacements("hello, world", rules)).toBe("hi, world");
  });

  it("should preserve trailing punctuation when replacing words", () => {
    const rules = [{ sourceValue: "hello", destinationValue: "hi" }];
    expect(applyReplacements("hello.", rules)).toBe("hi.");
    expect(applyReplacements("hello!", rules)).toBe("hi!");
    expect(applyReplacements("hello?", rules)).toBe("hi?");
    expect(applyReplacements("hello;", rules)).toBe("hi;");
    expect(applyReplacements("hello:", rules)).toBe("hi:");
  });

  it("should preserve leading punctuation when replacing words", () => {
    const rules = [{ sourceValue: "hello", destinationValue: "hi" }];
    expect(applyReplacements("(hello world", rules)).toBe("(hi world");
    expect(applyReplacements('"hello world', rules)).toBe('"hi world');
    expect(applyReplacements("'hello world", rules)).toBe("'hi world");
  });

  it("should preserve both leading and trailing punctuation", () => {
    const rules = [{ sourceValue: "hello", destinationValue: "hi" }];
    expect(applyReplacements("(hello)", rules)).toBe("(hi)");
    expect(applyReplacements('"hello"', rules)).toBe('"hi"');
    expect(applyReplacements("'hello'", rules)).toBe("'hi'");
    expect(applyReplacements("[hello]", rules)).toBe("[hi]");
  });

  it("should handle newlines and tabs with punctuation", () => {
    const rules = [{ sourceValue: "hello", destinationValue: "hi" }];
    expect(applyReplacements("hello,\n\nworld!", rules)).toBe("hi,\n\nworld!");
    expect(applyReplacements("\thello;", rules)).toBe("\thi;");
  });

  it("should preserve multiple trailing punctuation marks", () => {
    const rules = [{ sourceValue: "hello", destinationValue: "hi" }];
    expect(applyReplacements("hello!!!", rules)).toBe("hi!!!");
    expect(applyReplacements("hello...", rules)).toBe("hi...");
    expect(applyReplacements("hello?!", rules)).toBe("hi?!");
  });

  it("should handle punctuation in sentences", () => {
    const rules = [{ sourceValue: "LLM", destinationValue: "Claude" }];
    expect(applyReplacements("I love LLM!", rules)).toBe("I love Claude!");
    expect(applyReplacements("Is LLM good?", rules)).toBe("Is Claude good?");
    expect(applyReplacements("LLM, the best AI.", rules)).toBe(
      "Claude, the best AI.",
    );
  });

  it("should not modify words that don't match any rule", () => {
    const rules = [{ sourceValue: "foo", destinationValue: "bar" }];
    expect(applyReplacements("completely different text", rules)).toBe(
      "completely different text",
    );
  });

  it("should handle single word text", () => {
    const rules = [{ sourceValue: "LLM", destinationValue: "Claude" }];
    expect(applyReplacements("LLM", rules)).toBe("Claude");
  });

  it("should handle rules with multi-word destinations", () => {
    const rules = [
      { sourceValue: "AI", destinationValue: "Artificial Intelligence" },
    ];
    expect(applyReplacements("AI is amazing", rules)).toBe(
      "Artificial Intelligence is amazing",
    );
  });

  it("should handle empty source value gracefully", () => {
    const rules = [{ sourceValue: "", destinationValue: "bar" }];
    expect(applyReplacements("hello world", rules)).toBe("hello world");
  });

  it("should handle unicode characters", () => {
    const rules = [{ sourceValue: "café", destinationValue: "coffee shop" }];
    expect(applyReplacements("meet at café", rules)).toBe(
      "meet at coffee shop",
    );
  });

  it("should handle numbers in words", () => {
    const rules = [{ sourceValue: "v2", destinationValue: "version 2" }];
    expect(applyReplacements("I use v2", rules)).toBe("I use version 2");
  });

  it("should handle Spanish words with punctuation", () => {
    const rules = [{ sourceValue: "señor", destinationValue: "caballero" }];
    expect(applyReplacements("¡Hola, señor!", rules)).toBe("¡Hola, caballero!");
    expect(applyReplacements("¿Cómo está, señor?", rules)).toBe(
      "¿Cómo está, caballero?",
    );
  });

  it("should handle French words with accents", () => {
    const rules = [{ sourceValue: "français", destinationValue: "French" }];
    expect(applyReplacements("Je parle français.", rules)).toBe(
      "Je parle French.",
    );
    expect(applyReplacements("«français»", rules)).toBe("«French»");
  });

  it("should handle German words with umlauts", () => {
    const rules = [{ sourceValue: "größe", destinationValue: "size" }];
    expect(applyReplacements("Die größe ist gut.", rules)).toBe(
      "Die size ist gut.",
    );
  });

  it("should handle Chinese characters with spaces", () => {
    const rules = [{ sourceValue: "你好", destinationValue: "hello" }];
    // Works when words are separated by spaces
    expect(applyReplacements("你好 世界", rules)).toBe("hello 世界");
    expect(applyReplacements("「你好」", rules)).toBe("「hello」");
    // Without spaces, the entire string is one token and won't match
    expect(applyReplacements("你好，世界", rules)).toBe("你好，世界");
  });

  it("should handle Japanese characters with spaces", () => {
    const rules = [{ sourceValue: "こんにちは", destinationValue: "hello" }];
    // Works when words are separated by spaces
    expect(applyReplacements("こんにちは 世界", rules)).toBe("hello 世界");
    expect(applyReplacements("「こんにちは」", rules)).toBe("「hello」");
    // Without spaces, the entire string is one token and won't match
    expect(applyReplacements("こんにちは、世界", rules)).toBe(
      "こんにちは、世界",
    );
  });

  it("should handle Korean characters", () => {
    const rules = [{ sourceValue: "안녕", destinationValue: "hello" }];
    expect(applyReplacements("안녕, 세상", rules)).toBe("hello, 세상");
  });

  it("should handle Russian Cyrillic characters", () => {
    const rules = [{ sourceValue: "привет", destinationValue: "hello" }];
    expect(applyReplacements("привет, мир!", rules)).toBe("hello, мир!");
    expect(applyReplacements("«привет»", rules)).toBe("«hello»");
  });

  it("should handle Arabic characters", () => {
    const rules = [{ sourceValue: "مرحبا", destinationValue: "hello" }];
    expect(applyReplacements("مرحبا، عالم", rules)).toBe("hello، عالم");
  });

  it("should handle Greek characters", () => {
    const rules = [{ sourceValue: "γεια", destinationValue: "hello" }];
    expect(applyReplacements("γεια, κόσμε!", rules)).toBe("hello, κόσμε!");
  });
});

describe("applySymbolConversions", () => {
  it("should convert hashtag followed by word", () => {
    expect(applySymbolConversions("hashtag Rapha is awesome")).toBe(
      "#Rapha is awesome",
    );
    expect(applySymbolConversions("pound sign test")).toBe("#test");
    expect(applySymbolConversions("poundsign test")).toBe("#test");
  });

  it("should handle punctuation after symbol word", () => {
    expect(applySymbolConversions("Hashtag, this is great")).toBe(
      "#this is great",
    );
  });

  it("should handle multiple symbols in one string", () => {
    expect(applySymbolConversions("hashtag one at user")).toBe("#one at user");
  });

  it("should not convert symbol words not followed by another word", () => {
    expect(applySymbolConversions("I love hashtag")).toBe("I love hashtag");
  });

  it("should return original text when no symbols present", () => {
    expect(applySymbolConversions("hello world")).toBe("hello world");
  });

  it("should handle empty string", () => {
    expect(applySymbolConversions("")).toBe("");
  });
});
