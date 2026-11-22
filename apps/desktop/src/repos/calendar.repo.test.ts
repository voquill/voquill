import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CalendarNotFoundError,
  CalendarUnauthorizedError,
} from "../types/calendar.types";

type FakeResponse = { status: number; body?: unknown };

const fakes = vi.hoisted(() => ({
  responses: [] as FakeResponse[],
  requests: [] as { url: URL; authorization: string | undefined }[],
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: async (url: string, init: { headers: Record<string, string> }) => {
    fakes.requests.push({
      url: new URL(url),
      authorization: init.headers.Authorization,
    });
    const response = fakes.responses.shift() ?? { status: 200, body: {} };
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      json: async () => response.body,
    };
  },
}));

const { GoogleCalendarRepo } = await import("./calendar.repo");

const FROM = Date.UTC(2026, 10, 23, 17, 0);
const TO = FROM + 12 * 60 * 60_000;

const listEvents = (calendarId = "me@example.com") =>
  new GoogleCalendarRepo().listEvents({
    accessToken: "token",
    calendarId,
    accountEmail: "me@example.com",
    from: FROM,
    to: TO,
  });

const timedEvent = (id: string, start: string) => ({
  id,
  iCalUID: `${id}@google.com`,
  summary: id,
  start: { dateTime: start },
  end: { dateTime: start },
});

beforeEach(() => {
  fakes.responses = [];
  fakes.requests = [];
});

describe("GoogleCalendarRepo.listEvents", () => {
  it("asks for expanded, timed-ordered events in the range, without status blocks", async () => {
    await listEvents("team@group.calendar.google.com");

    const { url, authorization } = fakes.requests[0];
    expect(authorization).toBe("Bearer token");
    expect(url.pathname).toBe(
      "/calendar/v3/calendars/team%40group.calendar.google.com/events",
    );
    expect(url.searchParams.get("timeMin")).toBe(new Date(FROM).toISOString());
    expect(url.searchParams.get("timeMax")).toBe(new Date(TO).toISOString());
    expect(url.searchParams.get("singleEvents")).toBe("true");
    expect(url.searchParams.get("orderBy")).toBe("startTime");
    expect(url.searchParams.getAll("eventTypes")).toEqual([
      "default",
      "focusTime",
      "fromGmail",
    ]);
  });

  it("follows every page", async () => {
    fakes.responses = [
      {
        status: 200,
        body: {
          items: [timedEvent("one", "2026-11-23T18:00:00Z")],
          nextPageToken: "page-2",
        },
      },
      {
        status: 200,
        body: { items: [timedEvent("two", "2026-11-23T19:00:00Z")] },
      },
    ];

    const events = await listEvents();

    expect(events.map((event) => event.title)).toEqual(["one", "two"]);
    expect(fakes.requests[0].url.searchParams.has("pageToken")).toBe(false);
    expect(fakes.requests[1].url.searchParams.get("pageToken")).toBe("page-2");
  });

  it("leaves out events that never get a reminder", async () => {
    fakes.responses = [
      {
        status: 200,
        body: {
          items: [
            timedEvent("standup", "2026-11-23T18:00:00Z"),
            { id: "holiday", start: { date: "2026-11-24" } },
            {
              ...timedEvent("off", "2026-11-23T19:00:00Z"),
              status: "cancelled",
            },
          ],
        },
      },
    ];

    expect((await listEvents()).map((event) => event.title)).toEqual([
      "standup",
    ]);
  });

  it("reports a rejected token so the caller can refresh it", async () => {
    fakes.responses = [{ status: 401 }];

    await expect(listEvents()).rejects.toBeInstanceOf(
      CalendarUnauthorizedError,
    );
  });

  it("reports a calendar that no longer exists", async () => {
    fakes.responses = [{ status: 404 }];

    await expect(listEvents()).rejects.toBeInstanceOf(CalendarNotFoundError);
  });

  it("fails on any other error without calling the calendar missing", async () => {
    fakes.responses = [{ status: 403 }];

    const failure = await listEvents().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(CalendarNotFoundError);
    expect(failure).not.toBeInstanceOf(CalendarUnauthorizedError);
  });
});

describe("GoogleCalendarRepo.listCalendars", () => {
  it("lists the account's calendars", async () => {
    fakes.responses = [
      {
        status: 200,
        body: {
          items: [
            { id: "me@example.com", summary: "Me", primary: true },
            { id: "team", summary: "Team", backgroundColor: "#0b8043" },
          ],
        },
      },
    ];

    const calendars = await new GoogleCalendarRepo().listCalendars("token");

    expect(fakes.requests[0].url.pathname).toBe(
      "/calendar/v3/users/me/calendarList",
    );
    expect(calendars).toEqual([
      { id: "me@example.com", name: "Me", color: null, isPrimary: true },
      { id: "team", name: "Team", color: "#0b8043", isPrimary: false },
    ]);
  });
});
