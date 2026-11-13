import type { NoteSegment, NoteSource } from "@voquill/types";
import type { AppState } from "../state/app.state";
import { getIntl } from "../i18n";
import { buildNoteTranscriptText } from "./note-audio.utils";
import { getGenerativePrefs } from "./user.utils";

/** AI notes, titles and Ask need the user's post-processing model. */
export const getNoteGenerationAvailable = (state: AppState): boolean =>
  state.enterpriseConfig?.allowPostProcessing !== false &&
  getGenerativePrefs(state).mode !== "none";

/** Newest first, with the meeting in progress pinned on top. */
export const getSortedNoteIds = (state: AppState): string[] => {
  const activeNoteId = state.notes.activeNoteId;
  return Object.values(state.noteById)
    .sort((left, right) => {
      if (left.id === activeNoteId) return -1;
      if (right.id === activeNoteId) return 1;
      return right.createdAt.localeCompare(left.createdAt);
    })
    .map((note) => note.id);
};

/** Recorded audio so far, including the segment being captured now. */
export const getNoteElapsedMs = (state: AppState, noteId: string): number => {
  const note = state.noteById[noteId];
  const capture = state.notes.capture;
  const live = capture?.noteId === noteId ? capture.durationMs : 0;
  return (note?.durationMs ?? 0) + live;
};

export const formatNoteDuration = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => value.toString().padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
};

export const getDefaultNoteTitle = (
  source: NoteSource,
  createdAt: string,
): string => {
  const intl = getIntl();
  const date = intl.formatDate(createdAt, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return source === "import"
    ? intl.formatMessage(
        { defaultMessage: "Imported transcript, {date}" },
        { date },
      )
    : intl.formatMessage({ defaultMessage: "Meeting, {date}" }, { date });
};

export const getNoteTranscriptText = (
  state: AppState,
  noteId: string,
): string => buildNoteTranscriptText(state.noteSegmentsByNoteId[noteId] ?? []);

export type NoteAskAvailability =
  | "available"
  | "post-processing-disabled"
  | "no-transcript";

export const getNoteAskAvailability = (
  state: AppState,
  noteId: string | null,
): NoteAskAvailability => {
  if (!getNoteGenerationAvailable(state)) {
    return "post-processing-disabled";
  }
  if (noteId) {
    const note = state.noteById[noteId];
    const ready = note?.status === "ready";
    return ready && getNoteTranscriptText(state, noteId)
      ? "available"
      : "no-transcript";
  }
  return Object.values(state.noteById).some((note) => note.status === "ready")
    ? "available"
    : "no-transcript";
};

/** Offsets each segment's utterances by the audio recorded before it. */
export const getNoteSegmentOffsetsMs = (
  segments: NoteSegment[],
): Map<string, number> => {
  const offsets = new Map<string, number>();
  let offset = 0;
  for (const segment of segments) {
    offsets.set(segment.id, offset);
    offset += segment.durationMs;
  }
  return offsets;
};
