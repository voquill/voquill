import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { useIntl } from "react-intl";
import {
  handleMeetingCaptureProgress,
  handleResumableUploadProgress,
  initializeNotes,
  saveUnsyncedNoteEdits,
  stopMeetingNote,
} from "../../actions/note.actions";
import { syncCloudNotes } from "../../actions/note-sync.actions";
import { useIntervalAsync } from "../../hooks/helper.hooks";
import { useAsyncEffect } from "../../hooks/async.hooks";
import { useStartMeetingNote } from "../../hooks/note.hooks";
import { useTauriListen } from "../../hooks/tauri.hooks";
import {
  MEETING_CAPTURE_PROGRESS_EVENT,
  RESUMABLE_UPLOAD_PROGRESS_EVENT,
  type MeetingCaptureStatus,
  type ResumableUploadProgress,
} from "../../repos/meeting-audio.repo";
import { getAppState, useAppStore } from "../../store";
import { getLogger } from "../../utils/log.utils";
import {
  formatNoteDuration,
  getCloudNotesUserId,
  getNoteElapsedMs,
} from "../../utils/note.utils";
import { surfaceMainWindow } from "../../utils/window.utils";

/** List refresh while a cloud note processes (contract: every 10–15 s). */
const CLOUD_PROCESSING_REFRESH_MS = 15_000;

type TrayMeetingMenu = {
  startLabel: string | null;
  statusLabel: string | null;
  stopLabel: string | null;
};

export const NotesSideEffects = () => {
  const intl = useIntl();
  const startMeetingNote = useStartMeetingNote();

  const cloudNotesUserId = useAppStore(getCloudNotesUserId);
  useAsyncEffect(async () => {
    await initializeNotes().catch((error) => {
      getLogger().error(`Failed to initialize notes: ${error}`);
    });
  }, [cloudNotesUserId]);

  useEffect(() => {
    const onFocus = () => void syncCloudNotes();
    const onOnline = () => {
      saveUnsyncedNoteEdits();
      void syncCloudNotes({ force: true });
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  const hasProcessingCloudNote = useAppStore((state) =>
    Object.values(state.noteById).some(
      (note) => note.storage === "cloud" && note.status === "processing",
    ),
  );
  useIntervalAsync(CLOUD_PROCESSING_REFRESH_MS, async () => {
    if (hasProcessingCloudNote) {
      await syncCloudNotes({ force: true });
    }
  }, [hasProcessingCloudNote]);

  useTauriListen<ResumableUploadProgress>(
    RESUMABLE_UPLOAD_PROGRESS_EVENT,
    handleResumableUploadProgress,
  );

  useTauriListen<MeetingCaptureStatus>(
    MEETING_CAPTURE_PROGRESS_EVENT,
    handleMeetingCaptureProgress,
  );

  useTauriListen<void>("tray-start-meeting", async () => {
    await surfaceMainWindow();
    await startMeetingNote();
  });

  useTauriListen<void>("tray-stop-meeting", async () => {
    const activeNoteId = getAppState().notes.activeNoteId;
    if (activeNoteId) {
      await stopMeetingNote(activeNoteId);
    }
  });

  const trayMenu = useAppStore((state): TrayMeetingMenu => {
    const activeNoteId = state.notes.activeNoteId;
    if (!activeNoteId || !state.noteById[activeNoteId]) {
      return {
        startLabel: intl.formatMessage({
          defaultMessage: "Start Meeting Notes",
        }),
        statusLabel: null,
        stopLabel: null,
      };
    }
    const elapsed = formatNoteDuration(getNoteElapsedMs(state, activeNoteId));
    const isCapturing = state.notes.capture?.noteId === activeNoteId;
    return {
      startLabel: null,
      statusLabel: isCapturing
        ? intl.formatMessage(
            { defaultMessage: "Meeting in progress — {elapsed}" },
            { elapsed },
          )
        : intl.formatMessage(
            { defaultMessage: "Paused — {elapsed}" },
            { elapsed },
          ),
      stopLabel: intl.formatMessage({ defaultMessage: "Stop Meeting" }),
    };
  });

  useEffect(() => {
    invoke("set_tray_meeting_menu", { menu: trayMenu }).catch((error) => {
      getLogger().warning(`Failed to update tray meeting menu: ${error}`);
    });
  }, [trayMenu]);

  return null;
};
