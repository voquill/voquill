import { describe, expect, it } from "vitest";
import {
  getGoogleEventJoinUrl,
  toCalendar,
  toCalendarEvent,
  type GoogleCalendarEvent,
} from "./google-calendar.utils";

const ME = "me@example.com";

const toEvent = (event: GoogleCalendarEvent) => toCalendarEvent(event, ME);

const timed = (
  overrides: Partial<GoogleCalendarEvent> = {},
): GoogleCalendarEvent => ({
  id: "evt1",
  iCalUID: "uid1@google.com",
  status: "confirmed",
  summary: "Standup",
  start: { dateTime: "2026-11-23T10:00:00-07:00" },
  end: { dateTime: "2026-11-23T10:30:00-07:00" },
  ...overrides,
});

describe("toCalendarEvent", () => {
  it("reads the start and end as absolute instants", () => {
    const event = toEvent(timed());
    expect(event?.startsAt).toBe(Date.UTC(2026, 10, 23, 17, 0));
    expect(event?.endsAt).toBe(Date.UTC(2026, 10, 23, 17, 30));
    expect(event?.title).toBe("Standup");
  });

  it("skips all-day events", () => {
    expect(
      toEvent(
        timed({ start: { date: "2026-11-23" }, end: { date: "2026-11-24" } }),
      ),
    ).toBeNull();
  });

  it("skips cancelled events", () => {
    expect(toEvent(timed({ status: "cancelled" }))).toBeNull();
  });

  it("skips events the user declined", () => {
    expect(
      toEvent(
        timed({
          attendees: [
            { responseStatus: "accepted" },
            { self: true, responseStatus: "declined" },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("skips an event on a shared calendar that the user declined", () => {
    expect(
      toEvent(
        timed({
          attendees: [
            {
              self: true,
              email: "team@example.com",
              responseStatus: "accepted",
            },
            { email: "Me@Example.com", responseStatus: "declined" },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("keeps events the user has not answered or that others declined", () => {
    expect(
      toEvent(
        timed({
          attendees: [
            { responseStatus: "declined" },
            { self: true, responseStatus: "needsAction" },
          ],
        }),
      ),
    ).not.toBeNull();
  });

  it("gives the same key to one occurrence seen on two calendars", () => {
    const mine = toEvent(timed({ id: "evt1" }));
    const shared = toEvent(timed({ id: "evt1_copy" }));
    expect(mine?.key).toBe(shared?.key);
  });

  it("gives each occurrence of a recurring event its own key", () => {
    const monday = toEvent(timed());
    const tuesday = toEvent(
      timed({
        start: { dateTime: "2026-11-24T10:00:00-07:00" },
        end: { dateTime: "2026-11-24T10:30:00-07:00" },
      }),
    );
    expect(monday?.key).not.toBe(tuesday?.key);
  });

  it("has no title for an untitled event", () => {
    expect(toEvent(timed({ summary: "  " }))?.title).toBeNull();
  });
});

describe("getGoogleEventJoinUrl", () => {
  it("prefers the conference video link", () => {
    expect(
      getGoogleEventJoinUrl(
        timed({
          hangoutLink: "https://meet.google.com/aaa-bbbb-ccc",
          conferenceData: {
            entryPoints: [
              { entryPointType: "phone", uri: "tel:+1-555-0100" },
              { entryPointType: "video", uri: "https://zoom.us/j/123" },
            ],
          },
        }),
      ),
    ).toBe("https://zoom.us/j/123");
  });

  it("falls back to the Meet link", () => {
    expect(
      getGoogleEventJoinUrl(
        timed({ hangoutLink: "https://meet.google.com/aaa-bbbb-ccc" }),
      ),
    ).toBe("https://meet.google.com/aaa-bbbb-ccc");
  });

  it("finds a meeting link in the location", () => {
    expect(
      getGoogleEventJoinUrl(
        timed({ location: "Zoom: https://acme.zoom.us/j/987?pwd=abc" }),
      ),
    ).toBe("https://acme.zoom.us/j/987?pwd=abc");
  });

  it("finds a meeting link in an HTML description", () => {
    expect(
      getGoogleEventJoinUrl(
        timed({
          description:
            'Agenda: <a href="https://docs.example.com/a">doc</a> <a href="https://teams.microsoft.com/l/meetup-join/1?a=1&amp;b=2">Join</a>',
        }),
      ),
    ).toBe("https://teams.microsoft.com/l/meetup-join/1?a=1&b=2");
  });

  it("ignores links that are not meetings", () => {
    expect(
      getGoogleEventJoinUrl(
        timed({ location: "https://maps.example.com/office" }),
      ),
    ).toBeNull();
  });

  it("ignores hosts that only look like a meeting host", () => {
    expect(
      getGoogleEventJoinUrl(timed({ location: "https://notzoom.us/j/1" })),
    ).toBeNull();
  });

  it("ignores conference links that are not web links", () => {
    expect(
      getGoogleEventJoinUrl(
        timed({
          conferenceData: {
            entryPoints: [
              { entryPointType: "video", uri: "javascript:alert(1)" },
            ],
          },
        }),
      ),
    ).toBeNull();
  });
});

describe("toCalendar", () => {
  it("uses the name the user gave the calendar", () => {
    expect(
      toCalendar({
        id: "team@group.calendar.google.com",
        summary: "Team",
        summaryOverride: "My team",
        backgroundColor: "#0b8043",
      }),
    ).toEqual({
      id: "team@group.calendar.google.com",
      name: "My team",
      color: "#0b8043",
      isPrimary: false,
    });
  });
});
