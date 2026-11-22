import type { CalendarEvent } from "../types/calendar.types";

export const EVENT_REMINDER_LEAD_MS = 60_000;
/**
 * A reminder stays up at least this long, so an event with no duration does
 * not flash by. Longer than a sync interval plus a retry, so a short event
 * created at the last minute is still due when it is first fetched.
 */
export const EVENT_REMINDER_MIN_VISIBLE_MS = 10 * 60_000;

export const EVENT_REMINDER_CARD_WIDTH = 340;
export const EVENT_REMINDER_CARD_HEIGHT = 84;
export const EVENT_REMINDER_CARD_GAP = 8;
export const EVENT_REMINDER_WINDOW_MARGIN = 12;
const EVENT_REMINDER_MAX_VISIBLE_CARDS = 4;

export const getEventReminderExpiry = (event: CalendarEvent): number =>
  Math.max(event.endsAt, event.startsAt + EVENT_REMINDER_MIN_VISIBLE_MS);

/**
 * The events whose reminder should be on screen now: from one minute before
 * the start until the event ends, unless dismissed. An event first seen after
 * that minute has passed is still due, so it is never skipped. The latest to
 * start comes first, so a new reminder is never below ones that have been up
 * for a while.
 */
export const getDueEvents = (
  events: CalendarEvent[],
  dismissedKeys: Record<string, number>,
  now: number,
): CalendarEvent[] => {
  const dueByKey = new Map<string, CalendarEvent>();
  for (const event of events) {
    const isDue =
      now >= event.startsAt - EVENT_REMINDER_LEAD_MS &&
      now < getEventReminderExpiry(event);
    if (isDue && !(event.key in dismissedKeys) && !dueByKey.has(event.key)) {
      dueByKey.set(event.key, event);
    }
  }
  return [...dueByKey.values()].sort((a, b) => b.startsAt - a.startsAt);
};

/**
 * When the set of due events, or what their cards say, next changes: an
 * event becoming due, starting, or expiring. Null when nothing is coming up.
 */
export const getNextReminderChangeAt = (
  events: CalendarEvent[],
  now: number,
): number | null => {
  const upcoming = events
    .flatMap((event) => [
      event.startsAt - EVENT_REMINDER_LEAD_MS,
      event.startsAt,
      getEventReminderExpiry(event),
    ])
    .filter((changeAt) => changeAt > now);
  return upcoming.length > 0 ? Math.min(...upcoming) : null;
};

/**
 * Drops dismissals whose event is over. One whose event was extended after it
 * was dismissed is kept, so the reminder does not come back.
 */
export const pruneDismissedKeys = (
  dismissedKeys: Record<string, number>,
  events: CalendarEvent[],
  now: number,
): Record<string, number> => {
  const runningKeys = new Set(
    events
      .filter((event) => getEventReminderExpiry(event) > now)
      .map((event) => event.key),
  );
  return Object.fromEntries(
    Object.entries(dismissedKeys).filter(
      ([key, expiresAt]) => expiresAt > now || runningKeys.has(key),
    ),
  );
};

export const getEventReminderWindowHeight = (cardCount: number): number => {
  const visible = Math.min(
    Math.max(cardCount, 1),
    EVENT_REMINDER_MAX_VISIBLE_CARDS,
  );
  return (
    visible * EVENT_REMINDER_CARD_HEIGHT +
    (visible - 1) * EVENT_REMINDER_CARD_GAP
  );
};
