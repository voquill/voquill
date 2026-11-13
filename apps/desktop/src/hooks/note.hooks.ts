import { useCallback } from "react";
import { useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import { showErrorSnackbar, showSnackbar } from "../actions/app.actions";
import { startMeetingNote } from "../actions/note.actions";
import { getLogger } from "../utils/log.utils";

export const getNotePath = (noteId: string) => `/dashboard/notes/${noteId}`;

/** Starts a new meeting note and opens it, or opens the one in progress. */
export const useStartMeetingNote = () => {
  const intl = useIntl();
  const navigate = useNavigate();

  return useCallback(async () => {
    try {
      const { noteId, alreadyActive } = await startMeetingNote();
      if (alreadyActive) {
        showSnackbar(
          intl.formatMessage({
            defaultMessage:
              "A meeting is already in progress. Stop it to start a new one.",
          }),
        );
      }
      navigate(getNotePath(noteId));
    } catch (error) {
      getLogger().error(`Failed to start meeting note: ${error}`);
      showErrorSnackbar(
        intl.formatMessage({
          defaultMessage:
            "Couldn't start recording. Check that your microphone is connected and allowed.",
        }),
      );
    }
  }, [intl, navigate]);
};
