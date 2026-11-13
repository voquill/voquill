import type { IntlShape, MessageDescriptor } from "react-intl";
import { describe, expect, it } from "vitest";
import { describeNoteError, getNoteErrorAvailableAt } from "./note-error.utils";

// Message ids are generated at build time; tests read the default text.
const intl = {
  formatMessage: (descriptor: MessageDescriptor) => descriptor.defaultMessage,
} as unknown as IntlShape;

describe("describeNoteError", () => {
  it("explains quota errors with an upgrade path", () => {
    expect(describeNoteError(intl, "audio_quota_exceeded")).toMatchObject({
      title: "Meeting allowance reached",
      upgrade: true,
    });
  });

  it("falls back to a generic message for unknown codes", () => {
    expect(describeNoteError(intl, "something_new")).toMatchObject({
      title: "Processing didn't finish",
      retryable: true,
      availableAt: null,
    });
  });

  it("says when a limit frees up", () => {
    const result = describeNoteError(intl, {
      code: "ask_limit_exceeded",
      details: {
        used: 50,
        allowance: 50,
        resetsAt: "2999-01-01T00:00:00.000Z",
      },
    });
    expect(result.availableAt?.toISOString()).toBe("2999-01-01T00:00:00.000Z");
  });
});

describe("getNoteErrorAvailableAt", () => {
  it("reads retryAfterSeconds or the earliest future timestamp", () => {
    expect(
      getNoteErrorAvailableAt({ retryAfterSeconds: 120 }, 0)?.getTime(),
    ).toBe(120_000);
    expect(
      getNoteErrorAvailableAt(
        {
          freesAt: "1970-01-01T00:10:00.000Z",
          windowEndsAt: "1970-01-01T00:05:00.000Z",
          startedAt: "1969-12-31T00:00:00.000Z",
        },
        0,
      )?.getTime(),
    ).toBe(300_000);
    expect(getNoteErrorAvailableAt(null)).toBeNull();
  });
});
