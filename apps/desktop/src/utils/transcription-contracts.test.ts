import { describe, expect, it } from "vitest";
import {
  toDictationTranscriptEvent,
  toSharedTermPayload,
  toStoredTranscriptionContract,
  type DictationIntent,
} from "@voquill/types";
import { parseStructuredJsonResponse } from "./ai.utils";
import { PROCESSED_TRANSCRIPTION_SCHEMA } from "./prompt.utils";

describe("transcription contracts", () => {
  it("shared term payload preserves replacement destination", () => {
    const payload = toSharedTermPayload({
      sourceValue: "voquill",
      destinationValue: "Voquill",
      isReplacement: true,
    });

    expect(payload.destinationValue).toBe("Voquill");
  });

  it("transcript contract carries authoritative and finalized semantics", () => {
    const intent: DictationIntent = { kind: "dictation", format: "clean" };

    const payload = toDictationTranscriptEvent({
      text: "hello world",
      authoritativeText: "hello world",
      isAuthoritative: true,
      isFinal: true,
      intent,
    });

    expect(payload).toMatchObject({
      text: "hello world",
      authoritativeText: "hello world",
      isAuthoritative: true,
      isFinal: true,
      intent,
    });
  });

  it("stored transcription payload stays aligned with mobile contract fields", () => {
    const payload = toStoredTranscriptionContract({
      text: "Hello, world.",
      rawTranscript: "hello world",
      authoritativeTranscript: "hello world",
      isAuthoritative: true,
      isFinalized: true,
      dictationIntent: { kind: "dictation", format: "clean" },
    });

    expect(payload).toStrictEqual({
      text: "Hello, world.",
      rawTranscript: "hello world",
      authoritativeTranscript: "hello world",
      isAuthoritative: true,
      isFinalized: true,
      dictationIntent: { kind: "dictation", format: "clean" },
    });
  });

  it("post-processing contract stays aligned on the result field", () => {
    const payload = parseStructuredJsonResponse(
      JSON.stringify({
        result: {
          type: "transcription_cleaning",
          result: "Hello, world.",
        },
      }),
      "result",
    );

    expect(PROCESSED_TRANSCRIPTION_SCHEMA.parse(payload)).toStrictEqual({
      result: "Hello, world.",
    });
    expect(
      PROCESSED_TRANSCRIPTION_SCHEMA.safeParse({
        processedTranscription: "Hello, world.",
      }).success,
    ).toBe(false);
  });
});
