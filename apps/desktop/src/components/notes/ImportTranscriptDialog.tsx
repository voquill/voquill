import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
} from "@mui/material";
import { useEffect, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { showSnackbar } from "../../actions/app.actions";
import {
  closeImportTranscriptDialog,
  importNoteTranscript,
} from "../../actions/note.actions";
import { useAppStore } from "../../store";

export const ImportTranscriptDialog = () => {
  const intl = useIntl();
  const open = useAppStore((state) => state.notes.importDialogOpen);
  const [title, setTitle] = useState("");
  const [transcript, setTranscript] = useState("");

  useEffect(() => {
    if (open) {
      setTitle("");
      setTranscript("");
    }
  }, [open]);

  const canImport = transcript.trim().length > 0;

  const handleImport = () => {
    if (!canImport) return;
    importNoteTranscript({ title, transcript });
    closeImportTranscriptDialog();
    showSnackbar(
      intl.formatMessage({
        defaultMessage: "Writing notes for the imported transcript…",
      }),
    );
  };

  return (
    <Dialog
      open={open}
      onClose={closeImportTranscriptDialog}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle>
        <FormattedMessage defaultMessage="Import transcript" />
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField
            fullWidth
            label={<FormattedMessage defaultMessage="Title (optional)" />}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={10}
            maxRows={18}
            label={<FormattedMessage defaultMessage="Transcript" />}
            placeholder={intl.formatMessage({
              defaultMessage: "Paste a meeting transcript",
            })}
            value={transcript}
            onChange={(event) => setTranscript(event.target.value)}
          />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="text" onClick={closeImportTranscriptDialog}>
          <FormattedMessage defaultMessage="Cancel" />
        </Button>
        <Button
          variant="contained"
          onClick={handleImport}
          disabled={!canImport}
        >
          <FormattedMessage defaultMessage="Import" />
        </Button>
      </DialogActions>
    </Dialog>
  );
};
