import { fetch } from "@tauri-apps/plugin-http";
import type { Nullable } from "@voquill/types";
import {
  CalendarNotFoundError,
  CalendarUnauthorizedError,
  type Calendar,
  type CalendarEvent,
} from "../types/calendar.types";
import {
  GOOGLE_REMINDER_EVENT_TYPES,
  toCalendar,
  toCalendarEvent,
  type GoogleCalendarEvent,
  type GoogleCalendarListEntry,
} from "../utils/google-calendar.utils";
import { BaseRepo } from "./base.repo";

export type ListEventsArgs = {
  accessToken: string;
  calendarId: string;
  accountEmail: Nullable<string>;
  from: number;
  to: number;
};

export abstract class BaseCalendarRepo extends BaseRepo {
  abstract listCalendars(accessToken: string): Promise<Calendar[]>;
  /** Timed events overlapping the range that the user has not declined. */
  abstract listEvents(args: ListEventsArgs): Promise<CalendarEvent[]>;
}

const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const GOOGLE_PAGE_SIZE = "250";
const GOOGLE_REQUEST_TIMEOUT_MS = 30_000;

type GooglePage<T> = {
  items?: T[];
  nextPageToken?: string;
};

export class GoogleCalendarRepo extends BaseCalendarRepo {
  private async listAll<T>(
    accessToken: string,
    path: string,
    params: [string, string][],
  ): Promise<T[]> {
    const items: T[] = [];
    let pageToken: string | undefined;

    do {
      const query = new URLSearchParams(params);
      query.set("maxResults", GOOGLE_PAGE_SIZE);
      if (pageToken) query.set("pageToken", pageToken);

      const response = await fetch(`${GOOGLE_CALENDAR_API}${path}?${query}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS),
      });
      if (response.status === 401) {
        throw new CalendarUnauthorizedError("Google rejected the access token");
      }
      if (response.status === 404 || response.status === 410) {
        throw new CalendarNotFoundError(`Google has no calendar at ${path}`);
      }
      if (!response.ok) {
        throw new Error(`Google Calendar responded with ${response.status}`);
      }

      const page = (await response.json()) as GooglePage<T>;
      items.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);

    return items;
  }

  async listCalendars(accessToken: string): Promise<Calendar[]> {
    const entries = await this.listAll<GoogleCalendarListEntry>(
      accessToken,
      "/users/me/calendarList",
      [],
    );
    return entries.map(toCalendar);
  }

  async listEvents(args: ListEventsArgs): Promise<CalendarEvent[]> {
    const events = await this.listAll<GoogleCalendarEvent>(
      args.accessToken,
      `/calendars/${encodeURIComponent(args.calendarId)}/events`,
      [
        ["timeMin", new Date(args.from).toISOString()],
        ["timeMax", new Date(args.to).toISOString()],
        ["singleEvents", "true"],
        ["orderBy", "startTime"],
        ...GOOGLE_REMINDER_EVENT_TYPES.map((eventType): [string, string] => [
          "eventTypes",
          eventType,
        ]),
      ],
    );
    return events.flatMap(
      (event) => toCalendarEvent(event, args.accountEmail) ?? [],
    );
  }
}
