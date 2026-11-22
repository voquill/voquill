import type { Nullable } from "@voquill/types";

export const EVENT_REMINDER_WINDOW_LABEL = "event-reminders";

/** Main window -> popup: the cards to show, replacing the previous ones. */
export const EVT_EVENT_REMINDERS_UPDATE = "event-reminders:update";
/** Popup -> main window: the popup has loaded and needs its cards. */
export const EVT_EVENT_REMINDERS_READY = "event-reminders:ready";
export const EVT_EVENT_REMINDERS_DISMISS = "event-reminders:dismiss";
export const EVT_EVENT_REMINDERS_JOIN = "event-reminders:join";

export const EVT_WAKE_TIMER = "wake-timer";
export const EVENT_REMINDER_WAKE_TIMER_ID = "event-reminders";

export type WakeTimerPayload = {
  id: string;
};

export type EventReminderCard = {
  key: string;
  status: string;
  title: string;
  time: string;
  joinLabel: Nullable<string>;
  dismissLabel: string;
};

export type EventReminderActionPayload = {
  key: string;
};
