import { releaseNotesForLocalDataClear } from "../../actions/note.actions";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from "@mui/material";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { FormattedMessage } from "react-intl";
import { showSnackbar } from "../../actions/app.actions";
import { getAuthRepo } from "../../repos";
import { produceAppState, useAppStore } from "../../store";

export const DeleteAccountDialog = () => {
  const open = useAppStore((state) => state.settings.deleteAccountDialog);
  const userEmail = useAppStore((state) => state.auth?.email);
  const [confirmationEmail, setConfirmationEmail] = useState("");

  const isDeleteEnabled = confirmationEmail === userEmail && userEmail;

  const handleClose = () => {
    produceAppState((state) => {
      state.settings.deleteAccountDialog = false;
    });
    setConfirmationEmail("");
  };

  const handleSubmit = async () => {
    if (!isDeleteEnabled) {
      return;
    }

    try {
      await getAuthRepo().deleteMyAccount();
      await releaseNotesForLocalDataClear();
      await invoke("clear_local_data");
      setConfirmationEmail("");
      showSnackbar("You account has been deleted", { duration: 15000 });
      produceAppState((state) => {
        state.settings.deleteAccountDialog = false;
      });
      await getAuthRepo().signOut();
    } catch {
      showSnackbar(
        "An error occurred while attempting to delete your account. Please try again later.",
      );
    }
  };

  const handleEmailChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setConfirmationEmail(event.target.value);
  };

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="sm">
      <DialogTitle>
        <Typography variant="h6" component="div" fontWeight={600} color="error">
          <FormattedMessage defaultMessage="Delete account" />
        </Typography>
      </DialogTitle>
      <DialogContent>
        <Alert severity="warning" sx={{ mb: 2 }}>
          <FormattedMessage defaultMessage="This action cannot be undone. All your data will be permanently deleted." />
        </Alert>
        <Typography variant="body1" component="div" sx={{ mb: 2 }}>
          <FormattedMessage defaultMessage="Are you sure you want to delete your account? This will:" />
        </Typography>
        <Box component="ul" sx={{ pl: 2, mb: 2 }}>
          <Typography component="li" variant="body2">
            <FormattedMessage defaultMessage="Permanently delete all your data" />
          </Typography>
          <Typography component="li" variant="body2">
            <FormattedMessage defaultMessage="Cancel any active subscriptions" />
          </Typography>
          <Typography component="li" variant="body2">
            <FormattedMessage defaultMessage="Remove access to all premium features" />
          </Typography>
          <Typography component="li" variant="body2">
            <FormattedMessage defaultMessage="Sign you out immediately" />
          </Typography>
        </Box>
        {userEmail && (
          <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>
            <FormattedMessage
              defaultMessage="Account to be deleted: {email}"
              values={{ email: <strong>{userEmail}</strong> }}
            />
          </Typography>
        )}

        <Typography variant="body2" sx={{ mb: 1 }}>
          <FormattedMessage defaultMessage="To confirm, type your email address below:" />
        </Typography>
        <TextField
          fullWidth
          variant="outlined"
          placeholder={userEmail || ""}
          value={confirmationEmail}
          onChange={handleEmailChange}
          size="small"
          sx={{ mb: 2 }}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} variant="text">
          <FormattedMessage defaultMessage="Cancel" />
        </Button>
        <Button
          onClick={handleSubmit}
          variant="contained"
          color="error"
          disabled={!isDeleteEnabled}
        >
          <FormattedMessage defaultMessage="Delete account" />
        </Button>
      </DialogActions>
    </Dialog>
  );
};
