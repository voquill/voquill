import { describe, expect, it } from "vitest";
import {
  unwrapNestedLlmResponse,
  extractJsonFromMarkdown,
  recoverPlainTextFromLLMResponse,
} from "./ai.utils";

describe("unwrapNestedLlmResponse", () => {
  it("should return original object when value is already a string", () => {
    const input = { processedTranscription: "Hello world" };
    const result = unwrapNestedLlmResponse(input, "processedTranscription");
    expect(result).toEqual({ processedTranscription: "Hello world" });
  });

  it("should unwrap nested response when LLM wraps in schema name", () => {
    const input = {
      processedTranscription: {
        type: "transcription_cleaning",
        processedTranscription: "Hello world",
      },
    };
    const result = unwrapNestedLlmResponse(input, "processedTranscription");
    expect(result).toEqual({ processedTranscription: "Hello world" });
  });

  it("should preserve other fields when unwrapping", () => {
    const input = {
      processedTranscription: {
        processedTranscription: "Hello world",
      },
      otherField: "preserved",
    };
    const result = unwrapNestedLlmResponse(input, "processedTranscription");
    expect(result).toEqual({
      processedTranscription: "Hello world",
      otherField: "preserved",
    });
  });

  it("should not unwrap when nested value is not a string", () => {
    const input = {
      processedTranscription: {
        processedTranscription: 123,
      },
    };
    const result = unwrapNestedLlmResponse(input, "processedTranscription");
    expect(result).toEqual(input);
  });

  it("should not unwrap arrays", () => {
    const input = {
      items: ["a", "b", "c"],
    };
    const result = unwrapNestedLlmResponse(input, "items");
    expect(result).toEqual(input);
  });

  it("should handle null values", () => {
    const input = { processedTranscription: null };
    const result = unwrapNestedLlmResponse(
      input as Record<string, unknown>,
      "processedTranscription",
    );
    expect(result).toEqual({ processedTranscription: null });
  });

  it("should handle undefined values", () => {
    const input = { processedTranscription: undefined };
    const result = unwrapNestedLlmResponse(input, "processedTranscription");
    expect(result).toEqual({ processedTranscription: undefined });
  });

  it("should not unwrap when key does not exist in nested object", () => {
    const input = {
      processedTranscription: {
        someOtherKey: "value",
      },
    };
    const result = unwrapNestedLlmResponse(input, "processedTranscription");
    expect(result).toEqual(input);
  });

  it("should work with different key names", () => {
    const input = {
      result: {
        result: "extracted value",
      },
    };
    const result = unwrapNestedLlmResponse(input, "result");
    expect(result).toEqual({ result: "extracted value" });
  });

  it("should handle empty string values", () => {
    const input = {
      processedTranscription: {
        processedTranscription: "",
      },
    };
    const result = unwrapNestedLlmResponse(input, "processedTranscription");
    expect(result).toEqual({ processedTranscription: "" });
  });
});

describe("extractJsonFromMarkdown", () => {
  describe("Standard JSON Code Blocks", () => {
    it("should extract content from ```json code block", () => {
      const input = `\`\`\`json
{"name": "test"}
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe('{"name": "test"}');
    });

    it("should handle ```json code block with extra blank lines", () => {
      const input = `\`\`\`json


{"name": "test"}


\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe('{"name": "test"}');
    });

    it("should handle complex JSON objects", () => {
      const input = `\`\`\`json
{
  "name": "John",
  "age": 30,
  "hobbies": ["reading", "coding"]
}
\`\`\``;
      const expected = `{
  "name": "John",
  "age": 30,
  "hobbies": ["reading", "coding"]
}`;
      expect(extractJsonFromMarkdown(input)).toBe(expected);
    });
  });

  describe("Regular Code Blocks", () => {
    it("should extract content from ``` code block without json marker", () => {
      const input = `\`\`\`
{"name": "test"}
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe('{"name": "test"}');
    });

    it("should handle single-line code block", () => {
      const input = `\`\`\`{"name": "test"}\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe('{"name": "test"}');
    });
  });

  describe("Inline Code Blocks", () => {
    it("should extract inline code", () => {
      const input = '`{"name": "test"}`';
      expect(extractJsonFromMarkdown(input)).toBe('{"name": "test"}');
    });

    it("should extract inline code with surrounding text", () => {
      const input = 'Here is the JSON: `{"name": "test"}` for you';
      expect(extractJsonFromMarkdown(input)).toBe('{"name": "test"}');
    });
  });

  describe("Multiple Code Blocks", () => {
    it("should extract only the first code block", () => {
      const input = `\`\`\`json
{"first": 1}
\`\`\`
\`\`\`json
{"second": 2}
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe('{"first": 1}');
    });

    it("should extract only the first inline code block", () => {
      const input = '`{"first": 1}` and `{"second": 2}`';
      expect(extractJsonFromMarkdown(input)).toBe('{"first": 1}');
    });

    it("should handle mixed block and inline codes", () => {
      const input = `\`\`\`json
{"block": 1}
\`\`\`
 and \`{"inline": 2}\` and \`\`\`json
{"block2": 3}
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe('{"block": 1}');
    });
  });

  describe("Plain Text Without Markdown", () => {
    it("should return original text with whitespace trimmed", () => {
      const input = '  {"name": "test"}';
      expect(extractJsonFromMarkdown(input)).toBe('{"name": "test"}');
    });

    it("should return plain JSON string", () => {
      const input = '{"name": "test"}';
      expect(extractJsonFromMarkdown(input)).toBe('{"name": "test"}');
    });

    it("should handle empty string", () => {
      expect(extractJsonFromMarkdown("")).toBe("");
    });

    it("should handle whitespace-only string", () => {
      expect(extractJsonFromMarkdown("   ")).toBe("");
    });
  });

  describe("LLM Output Formats", () => {
    it("should extract JSON from LLM output with explanation", () => {
      const input = `Here's the JSON you requested:

\`\`\`json
{"name": "test", "value": 42}
\`\`\`

This JSON object contains the requested data.`;
      expect(extractJsonFromMarkdown(input)).toBe(
        '{"name": "test", "value": 42}',
      );
    });

    it("should extract JSON from LLM output with prefix", () => {
      const input = `Based on your request, here is the result:
\`\`\`json
{"result": "success"}
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe('{"result": "success"}');
    });

    it("should extract first JSON from multiple codeblocks in LLM output", () => {
      const input = `Here are some examples:

Example 1:
\`\`\`json
{"example": "first"}
\`\`\`

Example 2:
\`\`\`json
{"example": "second"}
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe('{"example": "first"}');
    });

    it("should extract JSON from LLM output with markdown formatting", () => {
      const input = `**Response:**

\`\`\`json
{"data": "value"}
\`\`\`

*End of response*`;
      expect(extractJsonFromMarkdown(input)).toBe('{"data": "value"}');
    });
  });

  describe("Edge Cases", () => {
    it("should prefer code block over inline code", () => {
      const input = '`{"inline": 1}` and ```json\n{"block": 2}\n```';
      expect(extractJsonFromMarkdown(input)).toBe('{"block": 2}');
    });

    it("should handle nested markdown text", () => {
      const input = `Some **bold** text with \`{"data": "value"}\` inline code`;
      expect(extractJsonFromMarkdown(input)).toBe('{"data": "value"}');
    });

    it("should skip inline code that doesn't look like JSON", () => {
      const input = "Text with `single backticks` but no code";
      expect(extractJsonFromMarkdown(input)).toBe(input.trim());
    });

    it("should skip non-JSON inline code and return raw text", () => {
      const input = "Some text with `startDictationRecording` and more text";
      expect(extractJsonFromMarkdown(input)).toBe(input.trim());
    });

    it("should extract array format", () => {
      const input = `\`\`\`json
[1, 2, 3]
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe("[1, 2, 3]");
    });

    it("should handle special characters", () => {
      const input = `\`\`\`json
{"text": "Hello\\nWorld\\t!"}
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe(
        '{"text": "Hello\\nWorld\\t!"}',
      );
    });

    it("should handle no newline at start", () => {
      const input = `\`\`\`json{"name": "test"}
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe('{"name": "test"}');
    });

    it("should handle no newline at end", () => {
      const input = `\`\`\`json
{"name": "test"}\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe('{"name": "test"}');
    });

    it("should handle multiple inline codes", () => {
      const input = '`{"a": 1}` middle `{"b": 2}` end';
      expect(extractJsonFromMarkdown(input)).toBe('{"a": 1}');
    });

    it("should handle whitespace in inline code", () => {
      const input = '`{ "name" : "test" }`';
      expect(extractJsonFromMarkdown(input)).toBe('{ "name" : "test" }');
    });

    it("should handle deeply nested brackets", () => {
      const input = `\`\`\`json
{
  "level1": {
    "level2": {
      "level3": {
        "data": [1, 2, [3, 4, [5]]]
      }
    }
  }
}
\`\`\``;
      const expected = `{
  "level1": {
    "level2": {
      "level3": {
        "data": [1, 2, [3, 4, [5]]]
      }
    }
  }
}`;
      expect(extractJsonFromMarkdown(input)).toBe(expected);
    });

    it("should extract first codeblock when multiple on same line", () => {
      const input = '```json {"first": 1}``` text ```json {"second": 2}```';
      expect(extractJsonFromMarkdown(input)).toBe('{"first": 1}');
    });
  });

  describe("Unicode and Special Characters", () => {
    it("should handle emoji in JSON", () => {
      const input = `\`\`\`json
{"message": "Hello 🌍🚀", "emoji": "😀"}
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe(
        '{"message": "Hello 🌍🚀", "emoji": "😀"}',
      );
    });

    it("should handle Chinese characters", () => {
      const input = `\`\`\`json
{"name": "测试", "description": "这是一个测试"}
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe(
        '{"name": "测试", "description": "这是一个测试"}',
      );
    });

    it("should handle Arabic and RTL text", () => {
      const input = `\`\`\`json
{"text": "مرحبا بالعالم", "hebrew": "שלום עולם"}
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe(
        '{"text": "مرحبا بالعالم", "hebrew": "שלום עולם"}',
      );
    });

    it("should handle escaped unicode sequences", () => {
      const input = `\`\`\`json
{"unicode": "\\u4e2d\\u6587", "emoji": "\\ud83d\\ude00"}
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe(
        '{"unicode": "\\u4e2d\\u6587", "emoji": "\\ud83d\\ude00"}',
      );
    });

    it("should handle special whitespace characters", () => {
      const input = `\`\`\`json
{"nbsp": "a\\u00a0b", "emsp": "c\\u2003d"}
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe(
        '{"nbsp": "a\\u00a0b", "emsp": "c\\u2003d"}',
      );
    });
  });

  describe("Line Endings", () => {
    it("should handle CRLF (Windows) line endings", () => {
      const input = `\`\`\`json\r\n{"name": "test"}\r\n\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe('{"name": "test"}');
    });

    it("should handle CR (old Mac) line endings", () => {
      const input = `\`\`\`json\r{"name": "test"}\r\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe('{"name": "test"}');
    });

    it("should handle mixed line endings", () => {
      const input = `\`\`\`json\r\n{"name": "test"}\n\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe('{"name": "test"}');
    });
  });

  describe("Known Limitations", () => {
    it("known limitation: cannot handle backticks inside code block (regex limitation)", () => {
      const input = `\`\`\`json
{
  "code": "value with \`\`\` backticks",
  "valid": true
}
\`\`\``;
      const result = extractJsonFromMarkdown(input);
      expect(result).toContain('"code": "value with');
    });

    it("known limitation: inline code stops at escaped backtick", () => {
      const input = '`{"text": "value with \\` backtick"}`';
      const result = extractJsonFromMarkdown(input);
      expect(result).toContain('{"text": "value with \\');
    });
  });
});

describe("recoverPlainTextFromLLMResponse", () => {
  it("returns null for empty string", () => {
    expect(recoverPlainTextFromLLMResponse("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(recoverPlainTextFromLLMResponse("   ")).toBeNull();
  });

  it("returns plain text directly when no JSON braces present", () => {
    expect(recoverPlainTextFromLLMResponse("Hello, world!")).toBe(
      "Hello, world!",
    );
  });

  it("trims surrounding whitespace from plain text", () => {
    expect(recoverPlainTextFromLLMResponse("  corrected transcript  ")).toBe(
      "corrected transcript",
    );
  });

  it("strips SYSTEM_INSTRUCTIONS leakage from plain text", () => {
    const input =
      "Good text <SYSTEM_INSTRUCTIONS>secret prompt</SYSTEM_INSTRUCTIONS> after";
    expect(recoverPlainTextFromLLMResponse(input)).toBe("Good text  after");
  });

  it("returns null when response is only SYSTEM_INSTRUCTIONS content", () => {
    const input =
      "<SYSTEM_INSTRUCTIONS>full secret</SYSTEM_INSTRUCTIONS>    ";
    expect(recoverPlainTextFromLLMResponse(input)).toBeNull();
  });

  it("extracts result field from valid JSON envelope", () => {
    const input = '{"result": "corrected text here"}';
    expect(recoverPlainTextFromLLMResponse(input)).toBe("corrected text here");
  });

  it("unescapes \\n sequences in extracted JSON result", () => {
    const input = '{"result": "line one\\nline two"}';
    expect(recoverPlainTextFromLLMResponse(input)).toBe("line one\nline two");
  });

  it("unescapes escaped quotes in extracted JSON result", () => {
    const input = '{"result": "he said \\"hello\\""}';
    expect(recoverPlainTextFromLLMResponse(input)).toBe('he said "hello"');
  });

  it("returns null for JSON object with no result field", () => {
    expect(recoverPlainTextFromLLMResponse('{"other": "value"}')).toBeNull();
  });

  it("returns null for an array (no useful text extractable)", () => {
    expect(recoverPlainTextFromLLMResponse("[1, 2, 3]")).toBeNull();
  });

  it("extracts result from JSON with extra whitespace around colon", () => {
    const input = '{"result"  :  "spaced value"}';
    expect(recoverPlainTextFromLLMResponse(input)).toBe("spaced value");
  });
});
