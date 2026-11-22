import { useEffect } from "react";
import {
  dismissEventReminder,
  joinEventReminder,
  showEventReminders,
  tickEventReminders,
} from "../../actions/calendar.actions";
import { useTauriListen } from "../../hooks/tauri.hooks";
import {
  EVENT_REMINDER_WAKE_TIMER_ID,
  EVT_EVENT_REMINDERS_DISMISS,
  EVT_EVENT_REMINDERS_JOIN,
  EVT_EVENT_REMINDERS_READY,
  EVT_WAKE_TIMER,
  type EventReminderActionPayload,
  type WakeTimerPayload,
} from "../../types/event-reminder.types";

/**
 * Keeps linked calendars synced and the event reminder popup up to date for
 * the app's lifetime. Each tick schedules the next one through the native
 * wake timer, because the webview's own timers stop while the main window
 * is hidden.
 */
export const CalendarSideEffects = () => {
  useEffect(() => {
    void tickEventReminders();
  }, []);

  useTauriListen<WakeTimerPayload>(EVT_WAKE_TIMER, async ({ id }) => {
    if (id === EVENT_REMINDER_WAKE_TIMER_ID) {
      await tickEventReminders();
    }
  });

  useTauriListen(EVT_EVENT_REMINDERS_READY, showEventReminders);
  useTauriListen<EventReminderActionPayload>(
    EVT_EVENT_REMINDERS_DISMISS,
    ({ key }) => dismissEventReminder(key),
  );
  useTauriListen<EventReminderActionPayload>(
    EVT_EVENT_REMINDERS_JOIN,
    ({ key }) => joinEventReminder(key),
  );

  return null;
};
