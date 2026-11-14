import type { NoteStatus } from "@voquill/types";
import { describe, expect, it } from "vitest";
import {
  canTransitionNote,
  recoverNoteStatus,
  syncNoteStatus,
  transitionNote,
  type NoteEvent,
} from "./note-state.utils";

const STATUSES: NoteStatus[] = [
  "recording",
  "paused",
  "pending",
  "processing",
  "ready",
  "failed",
];

const EVENTS: NoteEvent[] = [
  "pause",
  "resume",
  "interrupt",
  "finish",
  "start-processing",
  "succeed",
  "fail",
  "retry",
  "regenerate",
];

const ALLOWED: Record<string, NoteStatus> = {
  "recording:pause": "paused",
  "recording:interrupt": "paused",
  "recording:finish": "pending",
  "paused:resume": "recording",
  "paused:finish": "pending",
  "pending:start-processing": "processing",
  "pending:fail": "failed",
  "processing:succeed": "ready",
  "processing:fail": "failed",
  "ready:resume": "recording",
  "ready:regenerate": "pending",
  "ready:retry": "pending",
  "failed:retry": "pending",
};

describe("transitionNote", () => {
  for (const status of STATUSES) {
    for (const event of EVENTS) {
      const expected = ALLOWED[`${status}:${event}`];
      it(`${status} --${event}--> ${expected ?? "rejected"}`, () => {
        if (expected) {
          expect(canTransitionNote(status, event)).toBe(true);
          expect(transitionNote(status, event)).toBe(expected);
        } else {
          expect(canTransitionNote(status, event)).toBe(false);
          expect(() => transitionNote(status, event)).toThrow(
            /Invalid note transition/,
          );
        }
      });
    }
  }

  it("walks a full meeting: record, pause, resume, finish, process", () => {
    let status: NoteStatus = "recording";
    for (const event of [
      "pause",
      "resume",
      "finish",
      "start-processing",
      "succeed",
      "resume",
      "finish",
      "start-processing",
      "fail",
      "retry",
      "start-processing",
      "succeed",
      "regenerate",
    ] as NoteEvent[]) {
      status = transitionNote(status, event);
    }
    expect(status).toBe("pending");
  });
});

describe("recoverNoteStatus", () => {
  it("pauses a recording that is no longer being captured", () => {
    expect(recoverNoteStatus("recording", false)).toBe("paused");
  });

  it("keeps a recording the native layer is still capturing", () => {
    expect(recoverNoteStatus("recording", true)).toBe("recording");
  });

  it("queues interrupted processing again", () => {
    expect(recoverNoteStatus("processing", false)).toBe("pending");
  });

  it.each(["paused", "pending", "ready", "failed"] as NoteStatus[])(
    "leaves %s unchanged",
    (status) => {
      expect(recoverNoteStatus(status, false)).toBe(status);
    },
  );

  it("always lands in a status the machine can leave", () => {
    for (const status of STATUSES) {
      const recovered = recoverNoteStatus(status, false);
      expect(EVENTS.some((event) => canTransitionNote(recovered, event))).toBe(
        true,
      );
    }
  });
});

describe("syncNoteStatus", () => {
  it("keeps work in progress on this device", () => {
    expect(syncNoteStatus("recording", "ready")).toBe("recording");
    expect(syncNoteStatus("pending", "processing")).toBe("pending");
  });

  it("keeps what the device knows while the server only has a draft", () => {
    expect(syncNoteStatus("failed", "paused")).toBe("failed");
    expect(syncNoteStatus(null, "paused")).toBe("paused");
  });

  it("follows the server otherwise", () => {
    expect(syncNoteStatus("processing", "ready")).toBe("ready");
    expect(syncNoteStatus("failed", "processing")).toBe("processing");
    expect(syncNoteStatus("ready", "failed")).toBe("failed");
    expect(syncNoteStatus(null, "ready")).toBe("ready");
  });
});
