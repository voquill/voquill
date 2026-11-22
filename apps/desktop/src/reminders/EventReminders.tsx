import { emit, listen } from "@tauri-apps/api/event";
import { useEffect, useState, type CSSProperties } from "react";
import {
  EVT_EVENT_REMINDERS_DISMISS,
  EVT_EVENT_REMINDERS_JOIN,
  EVT_EVENT_REMINDERS_READY,
  EVT_EVENT_REMINDERS_UPDATE,
  type EventReminderActionPayload,
  type EventReminderCard,
} from "../types/event-reminder.types";
import {
  EVENT_REMINDER_CARD_GAP,
  EVENT_REMINDER_CARD_HEIGHT,
} from "../utils/event-reminder.utils";

const sendAction = (eventName: string, key: string) => {
  const payload: EventReminderActionPayload = { key };
  void emit(eventName, payload);
};

/**
 * The event reminder popup. It only draws the cards the main window sends
 * and reports clicks back; the main window decides what is shown.
 */
export const EventReminders = () => {
  const [cards, setCards] = useState<EventReminderCard[]>([]);

  useEffect(() => {
    const listening = listen<EventReminderCard[]>(
      EVT_EVENT_REMINDERS_UPDATE,
      (event) => setCards(event.payload),
    );
    void listening.then(() => emit(EVT_EVENT_REMINDERS_READY));

    return () => {
      void listening.then((unlisten) => unlisten());
    };
  }, []);

  const layout = {
    "--card-height": `${EVENT_REMINDER_CARD_HEIGHT}px`,
    "--card-gap": `${EVENT_REMINDER_CARD_GAP}px`,
  } as CSSProperties;

  return (
    <div className="reminders" style={layout}>
      {cards.map((card) => (
        <div className="reminder" key={card.key}>
          <div className="reminder-text">
            <div className="reminder-status">{card.status}</div>
            <div className="reminder-title">{card.title}</div>
            <div className="reminder-time">{card.time}</div>
          </div>
          <div className="reminder-actions">
            <button
              className="reminder-dismiss"
              aria-label={card.dismissLabel}
              title={card.dismissLabel}
              onClick={() => sendAction(EVT_EVENT_REMINDERS_DISMISS, card.key)}
            >
              <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
                <path
                  d="M2 2l8 8M10 2l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            {card.joinLabel && (
              <button
                className="reminder-join"
                onClick={() => sendAction(EVT_EVENT_REMINDERS_JOIN, card.key)}
              >
                {card.joinLabel}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};
