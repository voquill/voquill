import type { Nullable } from "@voquill/types";

export type CalendarProvider = "google";

export type CalendarAccount = {
  id: string;
  provider: CalendarProvider;
  email: Nullable<string>;
  createdAt: string;
  linkedCalendarIds: string[];
};

export type Calendar = {
  id: string;
  name: string;
  color: Nullable<string>;
  isPrimary: boolean;
};

export type CalendarEvent = {
  /** Identifies one occurrence, the same on every calendar it appears on. */
  key: string;
  title: Nullable<string>;
  startsAt: number;
  endsAt: number;
  joinUrl: Nullable<string>;
};

/** The provider rejected the access token; a fresh one may work. */
export class CalendarUnauthorizedError extends Error {}

/** The calendar was deleted or the account no longer has access to it. */
export class CalendarNotFoundError extends Error {}

export const CALENDAR_REAUTH_REQUIRED = "calendar_reauth_required";
export const CALENDAR_ACCESS_NOT_GRANTED = "calendar_access_not_granted";
