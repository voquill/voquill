import type { Nullable } from "@voquill/types";
import type { Calendar, CalendarEvent } from "../types/calendar.types";

export type GoogleCalendarListEntry = {
  id: string;
  summary?: string;
  summaryOverride?: string;
  backgroundColor?: string;
  primary?: boolean;
};

type GoogleEventTime = {
  dateTime?: string;
  date?: string;
};

export type GoogleCalendarEvent = {
  id: string;
  iCalUID?: string;
  status?: string;
  summary?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  hangoutLink?: string;
  location?: string;
  description?: string;
  conferenceData?: {
    entryPoints?: { entryPointType?: string; uri?: string }[];
  };
  attendees?: { self?: boolean; email?: string; responseStatus?: string }[];
};

/** Event types that are real events; working locations and out-of-office blocks are not. */
export const GOOGLE_REMINDER_EVENT_TYPES = [
  "default",
  "focusTime",
  "fromGmail",
];

const MEETING_HOSTS = [
  "zoom.us",
  "zoomgov.com",
  "meet.google.com",
  "teams.microsoft.com",
  "teams.live.com",
  "webex.com",
  "gotomeeting.com",
  "whereby.com",
  "chime.aws",
  "meet.jit.si",
];

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g;

const toWebUrl = (value: string | undefined): Nullable<URL> => {
  if (!value) return null;
  try {
    const url = new URL(value.replace(/&amp;/g, "&"));
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
};

const isMeetingUrl = (url: URL): boolean =>
  MEETING_HOSTS.some(
    (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
  );

const findMeetingUrl = (text: string | undefined): Nullable<string> => {
  for (const match of text?.match(URL_PATTERN) ?? []) {
    const url = toWebUrl(match);
    if (url && isMeetingUrl(url)) return url.toString();
  }
  return null;
};

export const getGoogleEventJoinUrl = (
  event: GoogleCalendarEvent,
): Nullable<string> => {
  const videoEntry = event.conferenceData?.entryPoints?.find(
    (entry) => entry.entryPointType === "video",
  );
  const conferenceUrl =
    toWebUrl(videoEntry?.uri) ?? toWebUrl(event.hangoutLink);
  return (
    conferenceUrl?.toString() ??
    findMeetingUrl(event.location) ??
    findMeetingUrl(event.description)
  );
};

/**
 * Null for events that never get a reminder: all-day events, cancelled ones
 * and ones the user declined. `self` marks the owner of the calendar the
 * copy is on, so on a shared calendar the user is found by email instead.
 */
export const toCalendarEvent = (
  event: GoogleCalendarEvent,
  accountEmail: Nullable<string>,
): Nullable<CalendarEvent> => {
  if (event.status === "cancelled") return null;
  if (!event.start?.dateTime || !event.end?.dateTime) return null;

  const email = accountEmail?.toLowerCase();
  const declined = event.attendees?.some(
    (attendee) =>
      attendee.responseStatus === "declined" &&
      (attendee.self || (!!email && attendee.email?.toLowerCase() === email)),
  );
  if (declined) return null;

  const startsAt = Date.parse(event.start.dateTime);
  const endsAt = Date.parse(event.end.dateTime);
  if (Number.isNaN(startsAt) || Number.isNaN(endsAt)) return null;

  return {
    key: `${event.iCalUID ?? event.id}:${startsAt}`,
    title: event.summary?.trim() || null,
    startsAt,
    endsAt,
    joinUrl: getGoogleEventJoinUrl(event),
  };
};

export const toCalendar = (entry: GoogleCalendarListEntry): Calendar => ({
  id: entry.id,
  name: entry.summaryOverride ?? entry.summary ?? entry.id,
  color: entry.backgroundColor ?? null,
  isPrimary: entry.primary ?? false,
});
