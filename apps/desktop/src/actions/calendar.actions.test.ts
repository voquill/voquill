import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALENDAR_REAUTH_REQUIRED,
  type Calendar,
  type CalendarAccount,
  type CalendarEvent,
} from "../types/calendar.types";
import type { EventReminderCard } from "../types/event-reminder.types";

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 10, 23, 17, 0);

type ListEvents = (
  calendarId: string,
  accessToken: string,
) => CalendarEvent[] | Promise<CalendarEvent[]>;

const fakes = vi.hoisted(() => ({
  accounts: [] as CalendarAccount[],
  listAccountsFails: false,
  linkedAccount: null as CalendarAccount | null,
  calendars: [] as Calendar[],
  listCalendarsFails: false,
  listEvents: (() => []) as ListEvents,
  syncedCalendarIds: [] as string[],
  tokenError: null as string | null,
  tokenRequests: [] as { id: string; forceRefresh: boolean }[],
  savedLinks: [] as { id: string; calendarIds: string[] }[],
  failNextSave: false,
  unlinked: [] as string[],
  invokes: [] as { command: string; args: unknown }[],
  popupGate: null as Promise<void> | null,
  emitted: [] as EventReminderCard[][],
  opened: [] as string[],
  toasts: [] as string[],
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: async (command: string, args: unknown) => {
    fakes.invokes.push({ command, args });
    if (command === "reminder_window_show") await fakes.popupGate;
  },
}));

vi.mock("../i18n/intl", () => ({
  getIntl: () => ({
    formatMessage: (descriptor: { defaultMessage: string }) =>
      descriptor.defaultMessage,
    formatTime: (time: number) => new Date(time).toISOString(),
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emitTo: async (
    _label: string,
    _event: string,
    cards: EventReminderCard[],
  ) => {
    fakes.emitted.push(cards);
  },
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: async (url: string) => {
    fakes.opened.push(url);
  },
}));

vi.mock("./toast.actions", () => ({
  showToast: async ({ message }: { message: string }) => {
    fakes.toasts.push(message);
  },
}));

vi.mock("../repos", () => ({
  getCalendarAccountRepo: () => ({
    listAccounts: async () => {
      if (fakes.listAccountsFails) throw new Error("database is locked");
      return fakes.accounts;
    },
    linkGoogleAccount: async () => {
      if (!fakes.linkedAccount) throw new Error("cancelled");
      return fakes.linkedAccount;
    },
    unlinkAccount: async (id: string) => {
      fakes.unlinked.push(id);
    },
    setLinkedCalendars: async (id: string, calendarIds: string[]) => {
      if (fakes.failNextSave) {
        fakes.failNextSave = false;
        throw new Error("disk full");
      }
      fakes.savedLinks.push({ id, calendarIds });
    },
    getAccessToken: async (id: string, forceRefresh: boolean) => {
      fakes.tokenRequests.push({ id, forceRefresh });
      if (fakes.tokenError) throw fakes.tokenError;
      return forceRefresh ? "fresh-token" : "cached-token";
    },
  }),
  getCalendarRepo: () => ({
    listCalendars: async () => {
      if (fakes.listCalendarsFails) throw new Error("offline");
      return fakes.calendars;
    },
    listEvents: async (args: { calendarId: string; accessToken: string }) => {
      fakes.syncedCalendarIds.push(args.calendarId);
      return fakes.listEvents(args.calendarId, args.accessToken);
    },
  }),
}));

const account = (
  id: string,
  linkedCalendarIds: string[] = ["primary"],
): CalendarAccount => ({
  id,
  provider: "google",
  email: `${id}@example.com`,
  createdAt: new Date(NOW).toISOString(),
  linkedCalendarIds,
});

const event = (
  key: string,
  startsInMs: number,
  overrides: Partial<CalendarEvent> = {},
): CalendarEvent => ({
  key,
  title: key,
  startsAt: NOW + startsInMs,
  endsAt: NOW + startsInMs + 30 * MINUTE,
  joinUrl: null,
  ...overrides,
});

/** Lets a sync that the tick started in the background run to the end. */
const settle = () => new Promise((resolve) => setTimeout(resolve));

/**
 * A fresh copy of the actions, as after an app start. The error classes come
 * from the same module graph, so the actions recognise them.
 */
const load = async (accounts: CalendarAccount[]) => {
  vi.resetModules();
  fakes.accounts = accounts;
  const actions = await import("./calendar.actions");
  const store = await import("../store");
  const errors = await import("../types/calendar.types");
  const { INITIAL_APP_STATE } = await import("../state/app.state");
  store.setAppState(INITIAL_APP_STATE, true);
  await actions.loadCalendarAccounts();

  const tick = async (at = Date.now()) => {
    vi.setSystemTime(at);
    await actions.tickEventReminders();
    await settle();
  };
  return { ...actions, ...store, ...errors, tick };
};

const invoked = (command: string) =>
  fakes.invokes.filter((call) => call.command === command);

const lastWakeDelay = () => {
  const args = invoked("wake_timer_set").at(-1)?.args as
    | { delayMs: number }
    | undefined;
  return args?.delayMs;
};

const shownTitles = () => fakes.emitted.at(-1)?.map((card) => card.title);

const lastPopupCall = () =>
  fakes.invokes
    .filter((call) => call.command.startsWith("reminder_window"))
    .at(-1)?.command;

const gate = () => {
  let open = () => {};
  const closed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { closed, open };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "error").mockImplementation(() => {});
  Object.assign(fakes, {
    accounts: [],
    listAccountsFails: false,
    linkedAccount: null,
    calendars: [],
    listCalendarsFails: false,
    listEvents: () => [],
    syncedCalendarIds: [],
    tokenError: null,
    tokenRequests: [],
    savedLinks: [],
    failNextSave: false,
    unlinked: [],
    invokes: [],
    popupGate: null,
    emitted: [],
    opened: [],
    toasts: [],
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("showing reminders", () => {
  it("shows the popup for an event that is due", async () => {
    fakes.listEvents = () => [event("standup", 30_000)];
    const { tick } = await load([account("a")]);

    await tick();

    expect(invoked("reminder_window_show")).toHaveLength(1);
    expect(shownTitles()).toEqual(["standup"]);
  });

  it("leaves the popup closed for an event more than a minute away", async () => {
    fakes.listEvents = () => [event("later", 10 * MINUTE)];
    const { tick } = await load([account("a")]);

    await tick();

    expect(invoked("reminder_window_show")).toHaveLength(0);
  });

  it("shows an event whose reminder time passed while the computer slept", async () => {
    fakes.listEvents = () => [event("standup", 10 * MINUTE)];
    const { tick } = await load([account("a")]);
    await tick();

    fakes.listEvents = () => {
      throw new Error("offline after wake");
    };
    await tick(NOW + 10 * MINUTE + 30_000);

    expect(fakes.emitted.at(-1)?.[0]).toMatchObject({
      title: "standup",
      status: "Happening now",
    });
  });

  it("shows an event once when two linked accounts both have it", async () => {
    fakes.listEvents = () => [event("standup", 30_000)];
    const { tick } = await load([account("a"), account("b")]);

    await tick();

    expect(shownTitles()).toEqual(["standup"]);
  });

  it("puts a new reminder above ones that are already up", async () => {
    fakes.listEvents = () => [
      event("on-call", -60 * MINUTE, { endsAt: NOW + 8 * 60 * MINUTE }),
      event("focus", -30 * MINUTE, { endsAt: NOW + 2 * 60 * MINUTE }),
      event("workshop", -20 * MINUTE, { endsAt: NOW + 60 * MINUTE }),
      event("office-hours", -10 * MINUTE, { endsAt: NOW + 60 * MINUTE }),
      event("standup", 30_000),
    ];
    const { tick } = await load([account("a")]);

    await tick();

    expect(shownTitles()?.[0]).toBe("standup");
    expect(shownTitles()).toHaveLength(5);
  });

  it("says when an event has started", async () => {
    fakes.listEvents = () => [event("standup", 30_000)];
    const { tick } = await load([account("a")]);

    await tick();
    expect(fakes.emitted.at(-1)?.[0].status).toBe("Starting soon");
    await tick(NOW + 30_000);

    expect(fakes.emitted.at(-1)?.[0].status).toBe("Happening now");
  });

  it("closes a popup left open by a reload when nothing is due", async () => {
    const { tick } = await load([account("a")]);

    await tick();

    expect(invoked("reminder_window_close")).toHaveLength(1);
  });

  it("offers a join button only for an event with a meeting link", async () => {
    fakes.listEvents = () => [
      event("standup", 30_000, { joinUrl: "https://meet.google.com/abc" }),
      event("lunch", 20_000),
    ];
    const { tick } = await load([account("a")]);

    await tick();

    expect(fakes.emitted.at(-1)?.map((card) => card.joinLabel)).toEqual([
      "Join",
      null,
    ]);
  });
});

describe("syncing linked calendars", () => {
  it("shows what is already known while a sync is stuck, and keeps ticking", async () => {
    fakes.listEvents = () => [event("standup", 5 * MINUTE + 30_000)];
    const { tick } = await load([account("a")]);
    await tick();

    fakes.syncedCalendarIds = [];
    fakes.invokes = [];
    fakes.listEvents = () => new Promise<CalendarEvent[]>(() => {});
    await tick(NOW + 5 * MINUTE);
    await tick(NOW + 5 * MINUTE + 10_000);

    expect(shownTitles()).toEqual(["standup"]);
    expect(lastWakeDelay()).toBe(20_000);
    expect(fakes.syncedCalendarIds).toEqual(["primary"]);
  });

  it("keeps an account's known events when its sync fails", async () => {
    fakes.listEvents = () => [event("standup", 5 * MINUTE + 30_000)];
    const { tick, getAppState } = await load([account("a")]);
    await tick();

    fakes.listEvents = () => {
      throw new Error("offline");
    };
    await tick(NOW + 5 * MINUTE);

    expect(getAppState().calendar.eventsByAccountId.a).toHaveLength(1);
    expect(shownTitles()).toEqual(["standup"]);
  });

  it("syncs again a minute after a failure, and not before", async () => {
    fakes.listEvents = () => {
      throw new Error("offline");
    };
    const { tick } = await load([account("a")]);

    await tick();
    await tick(NOW + 30_000);
    expect(fakes.syncedCalendarIds).toHaveLength(1);

    await tick(NOW + MINUTE);
    expect(fakes.syncedCalendarIds).toHaveLength(2);
  });

  it("syncs again five minutes after a success, and not before", async () => {
    const { tick } = await load([account("a")]);

    await tick();
    await tick(NOW + 4 * MINUTE);
    expect(fakes.syncedCalendarIds).toHaveLength(1);

    await tick(NOW + 5 * MINUTE);
    expect(fakes.syncedCalendarIds).toHaveLength(2);
  });

  it("asks for a fresh token when the cached one is rejected", async () => {
    const { tick, getAppState, CalendarUnauthorizedError } = await load([
      account("a"),
    ]);
    fakes.listEvents = (_calendarId, accessToken) => {
      if (accessToken === "cached-token") {
        throw new CalendarUnauthorizedError("rejected");
      }
      return [event("standup", 30_000)];
    };

    await tick();

    expect(fakes.tokenRequests.map((request) => request.forceRefresh)).toEqual([
      false,
      true,
    ]);
    expect(getAppState().calendar.eventsByAccountId.a).toHaveLength(1);
  });

  it("flags an account whose access was revoked, once, and stops syncing it", async () => {
    fakes.tokenError = CALENDAR_REAUTH_REQUIRED;
    const { tick, getAppState } = await load([account("a")]);

    await tick();
    await tick(NOW + 2 * MINUTE);

    expect(getAppState().calendar.reauthRequiredByAccountId.a).toBe(true);
    expect(fakes.toasts).toHaveLength(1);
    expect(fakes.tokenRequests).toHaveLength(1);
  });

  it("unlinks a calendar that no longer exists and keeps syncing the others", async () => {
    const { tick, getAppState, CalendarNotFoundError } = await load([
      account("a", ["primary", "gone"]),
    ]);
    fakes.listEvents = (calendarId) => {
      if (calendarId === "gone") throw new CalendarNotFoundError("gone");
      return [event("standup", 30_000)];
    };

    await tick();

    expect(getAppState().calendarAccountById.a.linkedCalendarIds).toEqual([
      "primary",
    ]);
    expect(fakes.savedLinks.at(-1)?.calendarIds).toEqual(["primary"]);
    expect(shownTitles()).toEqual(["standup"]);
  });

  it("syncs a calendar that was linked while a sync was fetching", async () => {
    const fetching = gate();
    fakes.listEvents = async () => {
      await fetching.closed;
      return [];
    };
    const { syncCalendarEvents, setCalendarLinked } = await load([
      account("a"),
    ]);

    const firstSync = syncCalendarEvents();
    const linking = setCalendarLinked("a", "team", true);
    await settle();
    expect(fakes.syncedCalendarIds).toEqual(["primary"]);
    fetching.open();
    await Promise.all([firstSync, linking]);

    expect(fakes.syncedCalendarIds).toEqual(["primary", "primary", "team"]);
  });

  it("syncs a calendar that was linked while a sync was updating the popup", async () => {
    const updating = gate();
    fakes.popupGate = updating.closed;
    fakes.listEvents = () => [event("standup", 30_000)];
    const { syncCalendarEvents, setCalendarLinked } = await load([
      account("a"),
    ]);

    const firstSync = syncCalendarEvents();
    await settle();
    expect(invoked("reminder_window_show")).toHaveLength(1);
    const linking = setCalendarLinked("a", "team", true);
    await settle();
    updating.open();
    await Promise.all([firstSync, linking]);

    expect(fakes.syncedCalendarIds).toEqual(["primary", "primary", "team"]);
  });
});

describe("scheduling the next tick", () => {
  it("wakes exactly when the next event becomes due", async () => {
    fakes.listEvents = () => [event("standup", MINUTE + 20_000)];
    const { tick } = await load([account("a")]);

    await tick();

    expect(lastWakeDelay()).toBe(20_000);
  });

  it("never waits longer than the cap, so a reminder is not late after sleep", async () => {
    fakes.listEvents = () => [event("later", 3 * 60 * MINUTE)];
    const { tick } = await load([account("a")]);

    await tick();

    expect(lastWakeDelay()).toBe(30_000);
  });

  it("schedules nothing while no calendar account is linked", async () => {
    const { tick } = await load([]);

    await tick();

    expect(invoked("wake_timer_set")).toHaveLength(0);
  });

  it("keeps trying when the accounts could not be loaded at startup", async () => {
    fakes.listAccountsFails = true;
    fakes.listEvents = () => [event("standup", 30_000)];
    const { tick } = await load([account("a")]);

    await tick();
    expect(lastWakeDelay()).toBe(30_000);
    expect(invoked("reminder_window_show")).toHaveLength(0);

    fakes.listAccountsFails = false;
    await tick(NOW + 30_000);

    expect(shownTitles()).toEqual(["standup"]);
  });
});

describe("dismissing and joining", () => {
  it("does not reopen a dismissed reminder, even after a reload", async () => {
    fakes.listEvents = () => [event("standup", 30_000)];
    const first = await load([account("a")]);
    await first.tick();

    await first.dismissEventReminder("standup");
    const dismissed = first.getAppState().local.dismissedEventReminders;
    expect(lastPopupCall()).toBe("reminder_window_close");

    fakes.invokes = [];
    const second = await load([account("a")]);
    second.produceAppState((draft) => {
      draft.local.dismissedEventReminders = dismissed;
    });
    await second.tick();

    expect(invoked("reminder_window_show")).toHaveLength(0);
  });

  it("keeps the other reminders up when one is dismissed", async () => {
    fakes.listEvents = () => [
      event("standup", 30_000),
      event("review", 45_000),
    ];
    const { tick, dismissEventReminder } = await load([account("a")]);
    await tick();

    await dismissEventReminder("standup");

    expect(shownTitles()).toEqual(["review"]);
  });

  it("keeps a dismissed event dismissed after it is extended", async () => {
    fakes.listEvents = () => [event("standup", 30_000)];
    const { tick, dismissEventReminder } = await load([account("a")]);
    await tick();
    await dismissEventReminder("standup");
    fakes.emitted = [];

    fakes.listEvents = () => [
      event("standup", 30_000, { endsAt: NOW + 90 * MINUTE }),
      event("review", 45 * MINUTE),
    ];
    await tick(NOW + 45 * MINUTE);
    expect(shownTitles()).toEqual(["review"]);
    await dismissEventReminder("review");
    await tick(NOW + 46 * MINUTE);

    expect(fakes.emitted.flat().map((card) => card.title)).toEqual(["review"]);
    expect(lastPopupCall()).toBe("reminder_window_close");
  });

  it("opens the meeting and dismisses the reminder on join", async () => {
    fakes.listEvents = () => [
      event("standup", 30_000, { joinUrl: "https://meet.google.com/abc" }),
    ];
    const { tick, joinEventReminder, getAppState } = await load([account("a")]);
    await tick();

    await joinEventReminder("standup");

    expect(fakes.opened).toEqual(["https://meet.google.com/abc"]);
    expect(getAppState().calendar.activeReminders).toEqual([]);
  });
});

describe("linking and unlinking", () => {
  const calendars: Calendar[] = [
    { id: "team", name: "Team", color: null, isPrimary: false },
    { id: "me@example.com", name: "Me", color: null, isPrimary: true },
  ];

  it("links the primary calendar of a new account and starts ticking", async () => {
    fakes.linkedAccount = account("a", []);
    fakes.calendars = calendars;
    fakes.listEvents = () => [event("standup", 30_000)];
    const { linkGoogleCalendarAccount, getAppState } = await load([]);

    await linkGoogleCalendarAccount();

    expect(getAppState().calendarAccountById.a.linkedCalendarIds).toEqual([
      "me@example.com",
    ]);
    expect(fakes.savedLinks).toEqual([
      { id: "a", calendarIds: ["me@example.com"] },
    ]);
    expect(shownTitles()).toEqual(["standup"]);
    expect(invoked("wake_timer_set").length).toBeGreaterThan(0);
  });

  it("links the primary calendar once the calendars load, if they failed at first", async () => {
    fakes.linkedAccount = account("a", []);
    fakes.calendars = calendars;
    fakes.listCalendarsFails = true;
    const { linkGoogleCalendarAccount, loadCalendars, getAppState } =
      await load([]);

    await linkGoogleCalendarAccount();
    expect(getAppState().calendar.linkStatus).toBe("success");
    expect(getAppState().calendarAccountById.a.linkedCalendarIds).toEqual([]);

    fakes.listCalendarsFails = false;
    await loadCalendars("a");
    await settle();

    expect(getAppState().calendarAccountById.a.linkedCalendarIds).toEqual([
      "me@example.com",
    ]);
    expect(fakes.syncedCalendarIds).toContain("me@example.com");
  });

  it("keeps the linked calendars of an account that is linked again", async () => {
    fakes.linkedAccount = account("a", ["team"]);
    fakes.calendars = calendars;
    const { linkGoogleCalendarAccount, produceAppState, getAppState } =
      await load([account("a", ["team"])]);
    produceAppState((draft) => {
      draft.calendar.reauthRequiredByAccountId.a = true;
    });

    await linkGoogleCalendarAccount();

    expect(getAppState().calendarAccountById.a.linkedCalendarIds).toEqual([
      "team",
    ]);
    expect(getAppState().calendar.reauthRequiredByAccountId.a).toBeUndefined();
    expect(fakes.savedLinks).toEqual([]);
    expect(fakes.syncedCalendarIds).toEqual(["team"]);
  });

  it("leaves nothing linked when linking is cancelled", async () => {
    const { linkGoogleCalendarAccount, getAppState } = await load([]);

    await linkGoogleCalendarAccount();

    expect(getAppState().calendar.accountIds).toEqual([]);
    expect(getAppState().calendar.linkStatus).toBe("error");
  });

  it("keeps a later change when an earlier one fails to save", async () => {
    fakes.failNextSave = true;
    const { setCalendarLinked, getAppState } = await load([account("a")]);

    await Promise.all([
      setCalendarLinked("a", "team", true),
      setCalendarLinked("a", "family", true),
    ]);

    expect(getAppState().calendarAccountById.a.linkedCalendarIds).toEqual([
      "primary",
      "family",
    ]);
    expect(fakes.savedLinks.at(-1)?.calendarIds).toEqual(["primary", "family"]);
  });

  it("takes an unlinked account's reminders down", async () => {
    fakes.listEvents = () => [event("standup", 30_000)];
    const { tick, unlinkCalendarAccount, getAppState } = await load([
      account("a"),
    ]);
    await tick();

    await unlinkCalendarAccount("a");

    expect(fakes.unlinked).toEqual(["a"]);
    expect(getAppState().calendar.accountIds).toEqual([]);
    expect(lastPopupCall()).toBe("reminder_window_close");
    expect(getAppState().calendar.activeReminders).toEqual([]);
  });
});
