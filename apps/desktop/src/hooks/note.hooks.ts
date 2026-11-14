import type { NoteSegment } from "@voquill/types";
import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import { showErrorSnackbar, showSnackbar } from "../actions/app.actions";
import { startMeetingNote } from "../actions/note.actions";
import { getAppState, useAppStore } from "../store";
import { getLogger } from "../utils/log.utils";
import {
  formatNoteTranscriptForCopy,
  getNoteTranscriptEntries,
} from "../utils/note-transcript.utils";

export const NOTES_PATH = "/dashboard/notes";

export const getNotePath = (noteId: string) => `${NOTES_PATH}/${noteId}`;

/**
 * Starts a new meeting note and opens it at once, or opens the one in
 * progress. If the microphone then cannot be opened, the note is removed and
 * its page is left.
 */
export const useStartMeetingNote = () => {
  const intl = useIntl();
  const navigate = useNavigate();

  return useCallback(async () => {
    const { noteId, alreadyActive, finishedNoteIds, started } =
      startMeetingNote();
    if (finishedNoteIds.length > 0) {
      showSnackbar(
        intl.formatMessage(
          {
            defaultMessage:
              "{count, plural, one {Your interrupted meeting was} other {# interrupted meetings were}} saved and queued for processing.",
          },
          { count: finishedNoteIds.length },
        ),
      );
    }
    if (alreadyActive) {
      showSnackbar(
        intl.formatMessage({
          defaultMessage:
            "A meeting is already in progress. Stop it to start a new one.",
        }),
      );
    }
    navigate(getNotePath(noteId));
    try {
      await started;
    } catch (error) {
      getLogger().error(`Failed to start meeting note: ${error}`);
      if (getAppState().notes.openNoteId === noteId) {
        navigate(NOTES_PATH, { replace: true });
      }
      showErrorSnackbar(
        intl.formatMessage({
          defaultMessage:
            "Couldn't start recording. Check that your microphone is connected and allowed.",
        }),
      );
    }
  }, [intl, navigate]);
};

const NO_SEGMENTS: NoteSegment[] = [];

export const useNoteTranscriptEntries = (noteId: string) => {
  const segments = useAppStore(
    (state) => state.noteSegmentsByNoteId[noteId] ?? NO_SEGMENTS,
  );
  return useMemo(() => getNoteTranscriptEntries(segments), [segments]);
};

/** Builds the transcript's plain-text copy (speaker labels and times). */
export const useNoteTranscriptCopyText = (noteId: string) => {
  const intl = useIntl();
  const entries = useNoteTranscriptEntries(noteId);
  return () =>
    formatNoteTranscriptForCopy(entries, (speaker) =>
      intl.formatMessage(
        { defaultMessage: "Speaker {number}" },
        { number: speaker + 1 },
      ),
    );
};
