import type { Note } from "@voquill/types";
import type { AppState } from "../state/app.state";
import { getActiveNoteId } from "./note.utils";

export type NoteListEntry = Pick<Note, "id" | "createdAt">;

/** The meeting in progress (pinned on top) and the other notes, newest first. */
export const getNoteList = (
  state: AppState,
): { activeNoteId: string | null; entries: NoteListEntry[] } => {
  const activeNoteId = getActiveNoteId(state);
  const entries = Object.values(state.noteById)
    .filter((note) => note.id !== activeNoteId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(({ id, createdAt }) => ({ id, createdAt }));
  return { activeNoteId, entries };
};

export type NoteDayGroup = {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
  kind: "today" | "yesterday" | "date";
  /** Noon of that local day, for formatting the header. */
  date: Date;
  noteIds: string[];
};

const pad = (value: number) => value.toString().padStart(2, "0");

export const getLocalDayKey = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** Calendar days between two local days (DST-safe: compares dates, not hours). */
const daysBetween = (from: Date, to: Date): number => {
  const start = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const end = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((end - start) / 86_400_000);
};

/**
 * Notes grouped by the local day they started, newest first; `notes` must
 * already be sorted newest first.
 */
export const groupNotesByDay = (
  notes: NoteListEntry[],
  now: Date,
): NoteDayGroup[] => {
  const groups: NoteDayGroup[] = [];
  for (const note of notes) {
    const created = new Date(note.createdAt);
    const day = getLocalDayKey(created);
    let group = groups.at(-1);
    if (group?.day !== day) {
      const age = daysBetween(created, now);
      group = {
        day,
        kind: age === 0 ? "today" : age === 1 ? "yesterday" : "date",
        date: new Date(
          created.getFullYear(),
          created.getMonth(),
          created.getDate(),
          12,
        ),
        noteIds: [],
      };
      groups.push(group);
    }
    group.noteIds.push(note.id);
  }
  return groups;
};
