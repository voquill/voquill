import { releaseNotesForLocalDataClear } from "../../actions/note.actions";
import { invoke } from "@tauri-apps/api/core";
import {
  Alert,
  AlertTitle,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useState } from "react";
import { FormattedMessage } from "react-intl";
import { produceAppState, useAppStore } from "../../store";

const CONFIRMATION_PHRASE = "clear";

export const ClearLocalDataDialog = () => {
  const open = useAppStore((state) => state.settings.clearLocalDataDialogOpen);
  const [confirmationValue, setConfirmationValue] = useState("");
  const [isClearing, setIsClearing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleClose = () => {
    produceAppState((draft) => {
      draft.settings.clearLocalDataDialogOpen = false;
    });
    setConfirmationValue("");
    setIsClearing(false);
    setErrorMessage(null);
  };

  const confirmationMatches =
    confirmationValue.trim().toLowerCase() === CONFIRMATION_PHRASE;

  const handleClear = async () => {
    if (!confirmationMatches || isClearing) {
      return;
    }

    setIsClearing(true);
    setErrorMessage(null);

    try {
      await releaseNotesForLocalDataClear();
      await invoke("clear_local_data");
      handleClose();
      window.location.reload();
    } catch (error) {
      console.error("Failed to clear local data", error);
      const message =
        error instanceof Error ? error.message : "Failed to clear local data.";
      setErrorMessage(message);
      setIsClearing(false);
    }
  };

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="sm">
      <DialogTitle>
        <FormattedMessage defaultMessage="Clear local data" />
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Alert severity="warning" variant="outlined">
            <AlertTitle>
              <FormattedMessage defaultMessage="This action permanently removes local data" />
            </AlertTitle>
            <Typography variant="body2">
              <FormattedMessage defaultMessage="This will delete all preferences, dictionary entries, saved transcriptions and notes, including meeting recordings, from this device. Notes stored in Voquill cloud stay in your account. The action cannot be undone." />
            </Typography>
          </Alert>
          <Typography variant="body2">
            <FormattedMessage
              defaultMessage="To confirm, type {phrase} below and click Clear local data."
              values={{
                phrase: (
                  <Typography
                    component="span"
                    variant="body2"
                    fontWeight="bold"
                    sx={{ fontFamily: "inherit" }}
                  >
                    {CONFIRMATION_PHRASE}
                  </Typography>
                ),
              }}
            />
          </Typography>
          <TextField
            autoFocus
            fullWidth
            label={<FormattedMessage defaultMessage="Confirmation phrase" />}
            value={confirmationValue}
            onChange={(event) => setConfirmationValue(event.target.value)}
            disabled={isClearing}
            placeholder={CONFIRMATION_PHRASE}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {errorMessage && (
            <Alert severity="error" variant="outlined">
              {errorMessage}
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={isClearing}>
          <FormattedMessage defaultMessage="Cancel" />
        </Button>
        <Button
          color="error"
          variant="contained"
          onClick={handleClear}
          disabled={!confirmationMatches || isClearing}
        >
          {isClearing ? (
            <FormattedMessage defaultMessage="Clearing..." />
          ) : (
            <FormattedMessage defaultMessage="Clear local data" />
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
