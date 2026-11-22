import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isEqual } from "lodash-es";
import { getIntl } from "../i18n/intl";
import { getCalendarAccountRepo, getCalendarRepo } from "../repos";
import { getAppState, produceAppState } from "../store";
import {
  CALENDAR_ACCESS_NOT_GRANTED,
  CALENDAR_REAUTH_REQUIRED,
  CalendarNotFoundError,
  CalendarUnauthorizedError,
  type CalendarAccount,
  type CalendarEvent,
} from "../types/calendar.types";
import {
  EVENT_REMINDER_WAKE_TIMER_ID,
  EVENT_REMINDER_WINDOW_LABEL,
  EVT_EVENT_REMINDERS_UPDATE,
  type EventReminderCard,
} from "../types/event-reminder.types";
import { registerCalendarAccounts } from "../utils/app.utils";
import {
  EVENT_REMINDER_CARD_WIDTH,
  EVENT_REMINDER_WINDOW_MARGIN,
  getDueEvents,
  getEventReminderExpiry,
  getEventReminderWindowHeight,
  getNextReminderChangeAt,
  pruneDismissedKeys,
} from "../utils/event-reminder.utils";
import {
  hoursToMilliseconds,
  minutesToMilliseconds,
} from "../utils/time.utils";
import { showErrorSnackbar } from "./app.actions";
import { showToast } from "./toast.actions";

const SYNC_INTERVAL_MS = minutesToMilliseconds(5);
const SYNC_RETRY_INTERVAL_MS = minutesToMilliseconds(1);
const SYNC_LOOKAHEAD_MS = hoursToMilliseconds(12);
/**
 * The longest the reminders go unchecked. The wake timer does not advance
 * while the computer sleeps, so this is also how late a reminder can be
 * after it wakes.
 */
const MAX_WAKE_DELAY_MS = 30_000;
const MIN_WAKE_DELAY_MS = 250;

let syncPromise: Promise<void> | null = null;
let resyncRequested = false;
let nextSyncAt = 0;
/** Null until the popup has been brought in line once, so a popup left open by a reload is closed. */
let shownCards: EventReminderCard[] | null = null;
let reminderWindowQueue: Promise<void> = Promise.resolve();
let linkedCalendarsQueue: Promise<void> = Promise.resolve();
/** Newly linked accounts whose primary calendar is linked once their calendars load. */
const accountsAwaitingDefaultCalendar = new Set<string>();

const withAccessToken = async <T>(
  account: CalendarAccount,
  call: (accessToken: string) => Promise<T>,
): Promise<T> => {
  const repo = getCalendarAccountRepo();
  try {
    try {
      return await call(await repo.getAccessToken(account.id, false));
    } catch (error) {
      if (!(error instanceof CalendarUnauthorizedError)) throw error;
      return await call(await repo.getAccessToken(account.id, true));
    }
  } catch (error) {
    if (String(error).includes(CALENDAR_REAUTH_REQUIRED)) {
      markReauthRequired(account);
    }
    throw error;
  }
};

const markReauthRequired = (account: CalendarAccount): void => {
  if (getAppState().calendar.reauthRequiredByAccountId[account.id]) return;

  produceAppState((draft) => {
    draft.calendar.reauthRequiredByAccountId[account.id] = true;
  });
  void showToast({
    message: getIntl().formatMessage({
      defaultMessage: "Google Calendar was disconnected. Link it again.",
    }),
    toastType: "error",
    duration: 8_000,
    action: "surface_window",
  });
};

export const loadCalendarAccounts = async (): Promise<void> => {
  const status = getAppState().calendar.accountsStatus;
  if (status === "loading" || status === "success") return;

  produceAppState((draft) => {
    draft.calendar.accountsStatus = "loading";
  });

  try {
    const accounts = await getCalendarAccountRepo().listAccounts();
    produceAppState((draft) => {
      registerCalendarAccounts(draft, accounts);
      draft.calendar.accountsStatus = "success";
    });
  } catch (error) {
    console.error("Failed to load calendar accounts", error);
    produceAppState((draft) => {
      draft.calendar.accountsStatus = "error";
    });
  }
};

export const loadCalendars = async (accountId: string): Promise<void> => {
  const account = getAppState().calendarAccountById[accountId];
  if (!account) return;

  produceAppState((draft) => {
    draft.calendar.calendarsStatusByAccountId[accountId] = "loading";
  });

  try {
    const calendars = await withAccessToken(account, (accessToken) =>
      getCalendarRepo(account.provider).listCalendars(accessToken),
    );
    produceAppState((draft) => {
      draft.calendar.calendarsByAccountId[accountId] = calendars;
      draft.calendar.calendarsStatusByAccountId[accountId] = "success";
    });

    const primary = calendars.find((calendar) => calendar.isPrimary);
    if (accountsAwaitingDefaultCalendar.delete(accountId) && primary) {
      await updateLinkedCalendars(accountId, () => [primary.id]);
      void syncCalendarEvents();
    }
  } catch (error) {
    console.error("Failed to load calendars", error);
    produceAppState((draft) => {
      draft.calendar.calendarsStatusByAccountId[accountId] = "error";
    });
  }
};

const setLinkedCalendarIds = (accountId: string, calendarIds: string[]) => {
  produceAppState((draft) => {
    const account = draft.calendarAccountById[accountId];
    if (account) account.linkedCalendarIds = calendarIds;
  });
};

/**
 * Changes run one at a time and each starts from the result of the one
 * before, so overlapping changes neither drop each other nor roll back to a
 * list that is no longer what is stored.
 */
const updateLinkedCalendars = (
  accountId: string,
  update: (calendarIds: string[]) => string[],
): Promise<void> => {
  const result = linkedCalendarsQueue.then(async () => {
    const previous =
      getAppState().calendarAccountById[accountId]?.linkedCalendarIds;
    if (!previous) return;

    const next = update(previous);
    setLinkedCalendarIds(accountId, next);
    try {
      await getCalendarAccountRepo().setLinkedCalendars(accountId, next);
    } catch (error) {
      setLinkedCalendarIds(accountId, previous);
      throw error;
    }
  });
  linkedCalendarsQueue = result.catch(() => undefined);
  return result;
};

export const setCalendarLinked = async (
  accountId: string,
  calendarId: string,
  linked: boolean,
): Promise<void> => {
  try {
    await updateLinkedCalendars(accountId, (calendarIds) => {
      const others = calendarIds.filter((id) => id !== calendarId);
      return linked ? [...others, calendarId] : others;
    });
    await syncCalendarEvents();
  } catch (error) {
    showErrorSnackbar(error);
  }
};

export const linkGoogleCalendarAccount = async (): Promise<void> => {
  if (getAppState().calendar.linkStatus === "loading") return;

  produceAppState((draft) => {
    draft.calendar.linkStatus = "loading";
  });

  let account: CalendarAccount;
  try {
    account = await getCalendarAccountRepo().linkGoogleAccount();
  } catch (error) {
    console.error("Failed to link Google Calendar", error);
    produceAppState((draft) => {
      draft.calendar.linkStatus = "error";
    });
    const intl = getIntl();
    showErrorSnackbar(
      String(error).includes(CALENDAR_ACCESS_NOT_GRANTED)
        ? intl.formatMessage({
            defaultMessage:
              "Voquill needs both calendar permissions to show event reminders. Link the account again and leave both boxes ticked.",
          })
        : intl.formatMessage({
            defaultMessage: "Google Calendar was not linked. Please try again.",
          }),
    );
    return;
  }

  produceAppState((draft) => {
    registerCalendarAccounts(draft, [account]);
    delete draft.calendar.reauthRequiredByAccountId[account.id];
    draft.calendar.linkStatus = "success";
  });
  if (account.linkedCalendarIds.length === 0) {
    accountsAwaitingDefaultCalendar.add(account.id);
  }

  await loadCalendars(account.id);
  await syncCalendarEvents();
};

export const unlinkCalendarAccount = async (
  accountId: string,
): Promise<void> => {
  try {
    await getCalendarAccountRepo().unlinkAccount(accountId);
    produceAppState((draft) => {
      delete draft.calendarAccountById[accountId];
      delete draft.calendar.calendarsByAccountId[accountId];
      delete draft.calendar.calendarsStatusByAccountId[accountId];
      delete draft.calendar.reauthRequiredByAccountId[accountId];
      delete draft.calendar.eventsByAccountId[accountId];
      draft.calendar.accountIds = draft.calendar.accountIds.filter(
        (id) => id !== accountId,
      );
    });
    await refreshEventReminders();
  } catch (error) {
    showErrorSnackbar(error);
  }
};

/**
 * A linked calendar that no longer exists is unlinked instead of failing the
 * account, which would leave its other calendars on stale events.
 */
const fetchAccountEvents = async (
  account: CalendarAccount,
  now: number,
): Promise<CalendarEvent[]> => {
  const repo = getCalendarRepo(account.provider);
  const missingCalendarIds = new Set<string>();

  const perCalendar = await withAccessToken(account, (accessToken) =>
    Promise.all(
      account.linkedCalendarIds.map(async (calendarId) => {
        try {
          return await repo.listEvents({
            accessToken,
            calendarId,
            accountEmail: account.email,
            from: now,
            to: now + SYNC_LOOKAHEAD_MS,
          });
        } catch (error) {
          if (!(error instanceof CalendarNotFoundError)) throw error;
          missingCalendarIds.add(calendarId);
          return [];
        }
      }),
    ),
  );

  if (missingCalendarIds.size > 0) {
    await updateLinkedCalendars(account.id, (calendarIds) =>
      calendarIds.filter((id) => !missingCalendarIds.has(id)),
    );
  }
  return perCalendar.flat();
};

const syncCalendarEventsOnce = async (): Promise<void> => {
  const state = getAppState();
  const now = Date.now();
  nextSyncAt = now + SYNC_RETRY_INTERVAL_MS;
  const accounts = state.calendar.accountIds
    .flatMap((id) => state.calendarAccountById[id] ?? [])
    .filter((account) => !state.calendar.reauthRequiredByAccountId[account.id]);

  const results = await Promise.all(
    accounts.map(async (account) => {
      try {
        return { account, events: await fetchAccountEvents(account, now) };
      } catch (error) {
        console.error("Failed to sync calendar events", error);
        return null;
      }
    }),
  );

  produceAppState((draft) => {
    for (const result of results) {
      if (result && draft.calendarAccountById[result.account.id]) {
        draft.calendar.eventsByAccountId[result.account.id] = result.events;
      }
    }
  });

  nextSyncAt =
    Date.now() +
    (results.every(Boolean) ? SYNC_INTERVAL_MS : SYNC_RETRY_INTERVAL_MS);
};

/**
 * Refreshes the upcoming events of every linked calendar. An account that
 * fails keeps the events from its last successful sync, so a network drop
 * does not lose a reminder that was already known. A call made while a sync
 * is running makes it run once more, so it sees the latest linked calendars.
 */
export const syncCalendarEvents = (): Promise<void> => {
  if (syncPromise) {
    resyncRequested = true;
    return syncPromise;
  }

  syncPromise = (async () => {
    do {
      resyncRequested = false;
      await syncCalendarEventsOnce();
      await refreshEventReminders();
    } while (resyncRequested);
  })().finally(() => {
    syncPromise = null;
  });

  return syncPromise;
};

const toEventReminderCard = (
  event: CalendarEvent,
  now: number,
): EventReminderCard => {
  const intl = getIntl();
  return {
    key: event.key,
    status:
      now < event.startsAt
        ? intl.formatMessage({ defaultMessage: "Starting soon" })
        : intl.formatMessage({ defaultMessage: "Happening now" }),
    title:
      event.title ?? intl.formatMessage({ defaultMessage: "Untitled event" }),
    time: `${intl.formatTime(event.startsAt)} – ${intl.formatTime(event.endsAt)}`,
    joinLabel: event.joinUrl
      ? intl.formatMessage({ defaultMessage: "Join" })
      : null,
    dismissLabel: intl.formatMessage({ defaultMessage: "Dismiss" }),
  };
};

const applyEventReminderCards = async (): Promise<void> => {
  const now = Date.now();
  const cards = getAppState().calendar.activeReminders.map((event) =>
    toEventReminderCard(event, now),
  );

  if (cards.length === 0) {
    await invoke("reminder_window_close");
  } else {
    await invoke("reminder_window_show", {
      args: {
        width: EVENT_REMINDER_CARD_WIDTH,
        height: getEventReminderWindowHeight(cards.length),
        margin: EVENT_REMINDER_WINDOW_MARGIN,
      },
    });
    await emitTo(
      EVENT_REMINDER_WINDOW_LABEL,
      EVT_EVENT_REMINDERS_UPDATE,
      cards,
    );
  }
  shownCards = cards;
};

/** Updates run one at a time so two of them never create the popup twice. */
export const showEventReminders = (): Promise<void> => {
  reminderWindowQueue = reminderWindowQueue
    .catch(() => undefined)
    .then(applyEventReminderCards);
  return reminderWindowQueue;
};

const setWakeTimer = async (delayMs: number): Promise<void> => {
  try {
    await invoke("wake_timer_set", {
      id: EVENT_REMINDER_WAKE_TIMER_ID,
      delayMs: Math.round(
        Math.min(Math.max(delayMs, MIN_WAKE_DELAY_MS), MAX_WAKE_DELAY_MS),
      ),
    });
  } catch (error) {
    console.error("Failed to schedule the next event reminder tick", error);
  }
};

/**
 * Asks to be woken for the next sync or reminder change. Nothing is scheduled
 * while no calendar is linked, so the app stays idle for everyone else.
 */
const scheduleNextTick = async (): Promise<void> => {
  const { accountIds, eventsByAccountId } = getAppState().calendar;
  if (accountIds.length === 0) return;

  const now = Date.now();
  const events = Object.values(eventsByAccountId).flat();
  const nextChangeAt = getNextReminderChangeAt(events, now) ?? Infinity;
  await setWakeTimer(Math.min(nextSyncAt, nextChangeAt) - now);
};

export const refreshEventReminders = async (): Promise<void> => {
  const state = getAppState();
  const now = Date.now();
  const due = getDueEvents(
    Object.values(state.calendar.eventsByAccountId).flat(),
    state.local.dismissedEventReminders ?? {},
    now,
  );

  if (!isEqual(due, state.calendar.activeReminders)) {
    produceAppState((draft) => {
      draft.calendar.activeReminders = due;
    });
  }

  try {
    const cards = due.map((event) => toEventReminderCard(event, now));
    if (!isEqual(cards, shownCards)) {
      await showEventReminders();
    }
  } catch (error) {
    console.error("Failed to update the event reminder popup", error);
  } finally {
    await scheduleNextTick();
  }
};

/**
 * Shows what is due from the events already known and schedules the next
 * tick before anything else, so a sync that is slow or stuck never holds a
 * reminder back.
 */
export const tickEventReminders = async (): Promise<void> => {
  if (getAppState().calendar.accountsStatus !== "success") {
    await loadCalendarAccounts();
    if (getAppState().calendar.accountsStatus !== "success") {
      await setWakeTimer(MAX_WAKE_DELAY_MS);
      return;
    }
  }

  if (Date.now() >= nextSyncAt && !syncPromise) {
    void syncCalendarEvents().catch((error) =>
      console.error("Failed to sync calendar events", error),
    );
  }
  await refreshEventReminders();
};

export const dismissEventReminder = async (key: string): Promise<void> => {
  const { activeReminders, eventsByAccountId } = getAppState().calendar;
  const event = activeReminders.find((reminder) => reminder.key === key);
  if (!event) return;

  produceAppState((draft) => {
    draft.local.dismissedEventReminders = {
      ...pruneDismissedKeys(
        draft.local.dismissedEventReminders ?? {},
        Object.values(eventsByAccountId).flat(),
        Date.now(),
      ),
      [key]: getEventReminderExpiry(event),
    };
  });
  await refreshEventReminders();
};

export const joinEventReminder = async (key: string): Promise<void> => {
  const event = getAppState().calendar.activeReminders.find(
    (reminder) => reminder.key === key,
  );
  if (event?.joinUrl) {
    await openUrl(event.joinUrl);
  }
  await dismissEventReminder(key);
};
