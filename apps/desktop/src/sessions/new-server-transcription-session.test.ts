import { describe, expect, it } from "vitest";
import {
  createNewServerTranscriptState,
  getNewServerTranscriptDelta,
  getRecoveredNewServerTranscriptResult,
} from "./new-server-transcription-session";

describe("getNewServerTranscriptDelta", () => {
  it("returns only the newly committed text for cumulative transcripts", () => {
    expect(
      getNewServerTranscriptDelta("hello world", "hello world again"),
    ).toBe("again");
  });

  it("returns the full transcript when the server transcript does not extend the previous one", () => {
    expect(getNewServerTranscriptDelta("hello world", "fresh start")).toBe(
      "fresh start",
    );
  });
});

describe("getRecoveredNewServerTranscriptResult", () => {
  it("returns a recovered transcript when committed text exists", () => {
    expect(
      getRecoveredNewServerTranscriptResult(
        "hello world",
        "socket closed unexpectedly",
      ),
    ).toEqual({
      text: "hello world",
      source: "New Server (Recovered Stream)",
      warnings: ["socket closed unexpectedly"],
    });
  });

  it("returns an empty transcript when nothing was committed", () => {
    expect(
      getRecoveredNewServerTranscriptResult("", "socket closed unexpectedly"),
    ).toEqual({
      text: "",
      source: "",
      warnings: ["socket closed unexpectedly"],
    });
  });
});

describe("createNewServerTranscriptState", () => {
  it("preserves the best-known streamed transcript cleanly during fallback recovery", () => {
    const transcriptState = createNewServerTranscriptState();

    transcriptState.applyStreamEvent({
      text: "hello wor",
      isFinal: true,
    });
    transcriptState.applyStreamEvent({
      text: "hello world",
      isFinal: true,
    });

    expect(
      transcriptState.toRecoveredResult("finalize timed out"),
    ).toEqual({
      text: "hello world",
      source: "New Server (Recovered Stream)",
      warnings: ["finalize timed out"],
    });
  });
});
