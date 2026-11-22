import type { Calendar, CalendarEvent } from "../types/calendar.types";
import type { ActionStatus } from "../types/state.types";

export type CalendarState = {
  accountIds: string[];
  accountsStatus: ActionStatus;
  linkStatus: ActionStatus;
  /** Loaded when the settings dialog shows an account. */
  calendarsByAccountId: Record<string, Calendar[]>;
  calendarsStatusByAccountId: Record<string, ActionStatus>;
  /** Accounts whose access was revoked; the user has to link them again. */
  reauthRequiredByAccountId: Record<string, boolean>;
  /** Upcoming events from each account's linked calendars, as of its last successful sync. */
  eventsByAccountId: Record<string, CalendarEvent[]>;
  activeReminders: CalendarEvent[];
};

export const INITIAL_CALENDAR_STATE: CalendarState = {
  accountIds: [],
  accountsStatus: "idle",
  linkStatus: "idle",
  calendarsByAccountId: {},
  calendarsStatusByAccountId: {},
  reauthRequiredByAccountId: {},
  eventsByAccountId: {},
  activeReminders: [],
};
