import { invoke } from "@tauri-apps/api/core";
import dayjs from "dayjs";
import type {
  CalendarAccount,
  CalendarProvider,
} from "../types/calendar.types";
import { BaseRepo } from "./base.repo";

type LocalCalendarAccount = {
  id: string;
  provider: CalendarProvider;
  email?: string | null;
  createdAt: number;
  linkedCalendarIds: string[];
};

const fromLocalCalendarAccount = (
  account: LocalCalendarAccount,
): CalendarAccount => ({
  id: account.id,
  provider: account.provider,
  email: account.email ?? null,
  createdAt: dayjs(account.createdAt).toISOString(),
  linkedCalendarIds: account.linkedCalendarIds,
});

export abstract class BaseCalendarAccountRepo extends BaseRepo {
  abstract listAccounts(): Promise<CalendarAccount[]>;
  abstract linkGoogleAccount(): Promise<CalendarAccount>;
  abstract unlinkAccount(id: string): Promise<void>;
  abstract setLinkedCalendars(id: string, calendarIds: string[]): Promise<void>;
  abstract getAccessToken(id: string, forceRefresh: boolean): Promise<string>;
}

export class LocalCalendarAccountRepo extends BaseCalendarAccountRepo {
  async listAccounts(): Promise<CalendarAccount[]> {
    const accounts = await invoke<LocalCalendarAccount[]>(
      "calendar_account_list",
    );
    return accounts.map(fromLocalCalendarAccount);
  }

  async linkGoogleAccount(): Promise<CalendarAccount> {
    const account = await invoke<LocalCalendarAccount>(
      "calendar_account_link_google",
    );
    return fromLocalCalendarAccount(account);
  }

  async unlinkAccount(id: string): Promise<void> {
    await invoke("calendar_account_unlink", { id });
  }

  async setLinkedCalendars(id: string, calendarIds: string[]): Promise<void> {
    await invoke("calendar_account_set_linked_calendars", { id, calendarIds });
  }

  async getAccessToken(id: string, forceRefresh: boolean): Promise<string> {
    return invoke<string>("calendar_account_access_token", {
      id,
      forceRefresh,
    });
  }
}
