import {
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from "@mui/material";
import { FormattedMessage } from "react-intl";
import { produceAppState, useAppStore } from "../../store";
import { getIsAssistantModeEnabled } from "../../utils/assistant-mode.utils";
import { getEffectiveStylingMode } from "../../utils/feature.utils";
import {
  ADD_TO_DICTIONARY_HOTKEY,
  AGENT_DICTATE_HOTKEY,
  CANCEL_TRANSCRIPTION_HOTKEY,
  DICTATE_HOTKEY,
  SWITCH_WRITING_STYLE_BACKWARD_HOTKEY,
  SWITCH_WRITING_STYLE_FORWARD_HOTKEY,
} from "../../utils/keyboard.utils";
import { HotkeySetting } from "./HotkeySetting";

export const ShortcutsDialog = () => {
  const isAssistantModeEnabled = useAppStore(getIsAssistantModeEnabled);
  const { open, hotkeysStatus, isManualStyling } = useAppStore((state) => ({
    open: state.settings.shortcutsDialogOpen,
    hotkeysStatus: state.settings.hotkeysStatus,
    isManualStyling: getEffectiveStylingMode(state) === "manual",
  }));

  const handleClose = () => {
    produceAppState((draft) => {
      draft.settings.shortcutsDialogOpen = false;
    });
  };

  const renderContent = () => {
    if (hotkeysStatus === "loading") {
      return (
        <Stack
          direction="row"
          justifyContent="center"
          alignItems="center"
          sx={{ py: 4 }}
        >
          <CircularProgress size={24} />
        </Stack>
      );
    }

    return (
      <Stack spacing={3}>
        <HotkeySetting
          title={<FormattedMessage defaultMessage="Start/stop dictating" />}
          description={
            <FormattedMessage defaultMessage="Start recording audio and transcribe your speech into text with AI." />
          }
          actionName={DICTATE_HOTKEY}
        />
        {isAssistantModeEnabled && (
          <HotkeySetting
            title={<FormattedMessage defaultMessage="Assistant mode" />}
            description={
              <FormattedMessage defaultMessage="Dictate commands for the AI to follow instead of just cleaning up text." />
            }
            actionName={AGENT_DICTATE_HOTKEY}
          />
        )}
        <HotkeySetting
          title={<FormattedMessage defaultMessage="Cancel transcription" />}
          description={
            <FormattedMessage defaultMessage="Cancel the current dictation or agent session." />
          }
          actionName={CANCEL_TRANSCRIPTION_HOTKEY}
        />
        <HotkeySetting
          title={<FormattedMessage defaultMessage="Add to dictionary" />}
          description={
            <FormattedMessage defaultMessage="Add the currently selected text to your dictionary." />
          }
          actionName={ADD_TO_DICTIONARY_HOTKEY}
        />
        {isManualStyling && (
          <>
            <HotkeySetting
              title={<FormattedMessage defaultMessage="Next writing style" />}
              description={
                <FormattedMessage defaultMessage="Cycle forward through your active writing styles while dictating." />
              }
              actionName={SWITCH_WRITING_STYLE_FORWARD_HOTKEY}
            />
            <HotkeySetting
              title={
                <FormattedMessage defaultMessage="Previous writing style" />
              }
              description={
                <FormattedMessage defaultMessage="Cycle backward through your active writing styles while dictating." />
              }
              actionName={SWITCH_WRITING_STYLE_BACKWARD_HOTKEY}
            />
          </>
        )}
      </Stack>
    );
  };

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="sm">
      <DialogTitle>
        <Stack spacing={1}>
          <Typography variant="h6">
            <FormattedMessage defaultMessage="Keyboard shortcuts" />
          </Typography>
          <Typography variant="body2" color="textSecondary">
            <FormattedMessage defaultMessage="Customize your keyboard shortcuts. Keyboard shortcuts can be triggered from within any app." />
          </Typography>
        </Stack>
      </DialogTitle>
      <DialogContent dividers>{renderContent()}</DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>
          <FormattedMessage defaultMessage="Close" />
        </Button>
      </DialogActions>
    </Dialog>
  );
};
