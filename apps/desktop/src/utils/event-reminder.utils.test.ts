import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../types/calendar.types";
import {
  EVENT_REMINDER_MIN_VISIBLE_MS,
  getDueEvents,
  getEventReminderWindowHeight,
  getNextReminderChangeAt,
  pruneDismissedKeys,
} from "./event-reminder.utils";

const MINUTE = 60_000;
const START = Date.UTC(2026, 10, 23, 17, 0);

const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  key: "standup",
  title: "Standup",
  startsAt: START,
  endsAt: START + 30 * MINUTE,
  joinUrl: null,
  ...overrides,
});

const dueKeys = (
  events: CalendarEvent[],
  now: number,
  dismissed: Record<string, number> = {},
) => getDueEvents(events, dismissed, now).map((due) => due.key);

describe("getDueEvents", () => {
  it("is not due more than a minute before the start", () => {
    expect(dueKeys([event()], START - MINUTE - 1)).toEqual([]);
  });

  it("becomes due exactly one minute before the start", () => {
    expect(dueKeys([event()], START - MINUTE)).toEqual(["standup"]);
  });

  it("stays due for an event first seen after it started", () => {
    expect(dueKeys([event()], START + 10 * MINUTE)).toEqual(["standup"]);
  });

  it("stops being due when the event ends", () => {
    expect(dueKeys([event()], START + 30 * MINUTE - 1)).toEqual(["standup"]);
    expect(dueKeys([event()], START + 30 * MINUTE)).toEqual([]);
  });

  it("keeps an event with no duration up for the minimum time", () => {
    const instant = event({ endsAt: START });
    expect(
      dueKeys([instant], START + EVENT_REMINDER_MIN_VISIBLE_MS - 1),
    ).toEqual(["standup"]);
    expect(dueKeys([instant], START + EVENT_REMINDER_MIN_VISIBLE_MS)).toEqual(
      [],
    );
  });

  it("skips a dismissed event", () => {
    expect(dueKeys([event()], START, { standup: START + 30 * MINUTE })).toEqual(
      [],
    );
  });

  it("shows an event once when it is on two linked calendars", () => {
    expect(dueKeys([event(), event()], START)).toEqual(["standup"]);
  });

  it("puts the latest to start first, above reminders already up", () => {
    const later = event({ key: "review", startsAt: START + 30_000 });
    expect(dueKeys([event(), later], START)).toEqual(["review", "standup"]);
  });
});

describe("getNextReminderChangeAt", () => {
  it("is the moment the next event becomes due", () => {
    expect(getNextReminderChangeAt([event()], START - 10 * MINUTE)).toBe(
      START - MINUTE,
    );
  });

  it("is the start once the event is due, then the end", () => {
    expect(getNextReminderChangeAt([event()], START - MINUTE)).toBe(START);
    expect(getNextReminderChangeAt([event()], START)).toBe(START + 30 * MINUTE);
  });

  it("is the earliest change across events", () => {
    const sooner = event({ key: "review", startsAt: START - 5 * MINUTE });
    expect(
      getNextReminderChangeAt([event(), sooner], START - 10 * MINUTE),
    ).toBe(START - 6 * MINUTE);
  });

  it("is null when every event is over", () => {
    expect(getNextReminderChangeAt([event()], START + 30 * MINUTE)).toBeNull();
    expect(getNextReminderChangeAt([], START)).toBeNull();
  });
});

describe("pruneDismissedKeys", () => {
  it("drops dismissals for events that are over", () => {
    expect(
      pruneDismissedKeys({ over: START - 1, running: START + 1 }, [], START),
    ).toEqual({ running: START + 1 });
  });

  it("keeps a dismissal whose event was extended past its stored end", () => {
    const extended = event({ endsAt: START + 60 * MINUTE });
    expect(
      pruneDismissedKeys(
        { standup: START + 30 * MINUTE },
        [extended],
        START + 45 * MINUTE,
      ),
    ).toEqual({ standup: START + 30 * MINUTE });
  });
});

describe("getEventReminderWindowHeight", () => {
  it("grows with each card and stops at the visible limit", () => {
    const one = getEventReminderWindowHeight(1);
    const two = getEventReminderWindowHeight(2);
    expect(two).toBeGreaterThan(one);
    expect(getEventReminderWindowHeight(9)).toBe(
      getEventReminderWindowHeight(4),
    );
  });
});
