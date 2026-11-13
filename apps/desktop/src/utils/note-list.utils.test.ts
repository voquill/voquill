import type { Note } from "@voquill/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getLocalDayKey, groupNotesByDay } from "./note-list.utils";

const originalTz = process.env.TZ;
beforeAll(() => {
  // A zone with daylight saving time, so day boundaries are tested across it.
  process.env.TZ = "America/Denver";
});
afterAll(() => {
  process.env.TZ = originalTz;
});

const note = (id: string, createdAt: Date): Note => ({
  id,
  storage: "local",
  status: "ready",
  title: id,
  titleSource: "ai",
  error: null,
  source: "recording",
  personalNotes: "",
  generatedNotes: null,
  durationMs: 0,
  createdAt: createdAt.toISOString(),
  updatedAt: createdAt.toISOString(),
  cloud: null,
});

describe("groupNotesByDay", () => {
  it("splits at local midnight, not UTC midnight", () => {
    const now = new Date(2026, 4, 2, 9, 0);
    const groups = groupNotesByDay(
      [
        note("after-midnight", new Date(2026, 4, 2, 0, 0, 0)),
        note("before-midnight", new Date(2026, 4, 1, 23, 59, 59)),
        note("evening", new Date(2026, 4, 1, 18, 0)),
        note("older", new Date(2026, 3, 28, 10, 0)),
      ],
      now,
    );
    expect(groups.map((g) => [g.kind, g.noteIds])).toEqual([
      ["today", ["after-midnight"]],
      ["yesterday", ["before-midnight", "evening"]],
      ["date", ["older"]],
    ]);
    expect(groups[2].day).toBe("2026-04-28");
  });

  it("moves notes to Yesterday right after midnight", () => {
    const now = new Date(2026, 4, 2, 0, 0, 30);
    const groups = groupNotesByDay(
      [
        note("just-now", new Date(2026, 4, 2, 0, 0, 5)),
        note("late", new Date(2026, 4, 1, 23, 59, 59)),
        note("two-days", new Date(2026, 3, 30, 23, 59, 59)),
      ],
      now,
    );
    expect(groups.map((g) => g.kind)).toEqual(["today", "yesterday", "date"]);
  });

  it("runs in a zone with daylight saving time", () => {
    expect(new Date(2026, 2, 7, 12).getTimezoneOffset()).toBe(420);
    expect(new Date(2026, 2, 9, 12).getTimezoneOffset()).toBe(360);
  });

  it("counts calendar days across a daylight saving change", () => {
    // US daylight saving started on 2026-03-08 (a 23-hour day).
    const now = new Date(2026, 2, 9, 0, 30);
    const groups = groupNotesByDay(
      [
        note("monday", new Date(2026, 2, 9, 0, 10)),
        note("sunday", new Date(2026, 2, 8, 0, 30)),
        note("saturday", new Date(2026, 2, 7, 23, 30)),
      ],
      now,
    );
    expect(groups.map((g) => g.kind)).toEqual(["today", "yesterday", "date"]);
  });

  it("uses the local calendar day as the key", () => {
    expect(getLocalDayKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });

  it("handles hundreds of notes in one pass", () => {
    const now = new Date(2026, 4, 2, 12);
    const notes = Array.from({ length: 900 }, (_, i) =>
      note(`n${i}`, new Date(now.getTime() - i * 3 * 60 * 60 * 1000)),
    );
    const groups = groupNotesByDay(notes, now);
    expect(groups.reduce((sum, g) => sum + g.noteIds.length, 0)).toBe(900);
    expect(groups[0].kind).toBe("today");
  });
});
