import { TextField } from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { setNotePersonalNotes } from "../../actions/note.actions";
import { useAppStore } from "../../store";
import { flatFieldSx } from "./NoteLayout";

const SAVE_DEBOUNCE_MS = 600;

/** The user's own notes; saved as they type and flushed when they leave. */
export const PersonalNotesEditor = ({
  noteId,
  minRows = 8,
}: {
  noteId: string;
  minRows?: number;
}) => {
  const intl = useIntl();
  const stored = useAppStore(
    (state) => state.noteById[noteId]?.personalNotes ?? "",
  );
  const [draft, setDraft] = useState(stored);
  const pendingRef = useRef<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (pendingRef.current !== null) {
      void setNotePersonalNotes(noteId, pendingRef.current);
      pendingRef.current = null;
    }
  }, [noteId]);

  useEffect(() => {
    if (pendingRef.current === null) {
      setDraft(stored);
    }
  }, [stored]);

  useEffect(() => flush, [flush]);

  const handleChange = (value: string) => {
    setDraft(value);
    pendingRef.current = value;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
  };

  return (
    <TextField
      fullWidth
      multiline
      minRows={minRows}
      value={draft}
      onChange={(event) => handleChange(event.target.value)}
      onBlur={flush}
      placeholder={intl.formatMessage({
        defaultMessage:
          "Jot down anything you want the notes to emphasize. Your notes are kept as you write them.",
      })}
      slotProps={{
        htmlInput: {
          "aria-label": intl.formatMessage({ defaultMessage: "My notes" }),
        },
      }}
      sx={flatFieldSx}
    />
  );
};
