import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Select,
  SelectChangeEvent,
  Stack,
  Typography,
} from "@mui/material";
import { useMemo } from "react";
import { AppTarget } from "@repo/types";
import { FormattedMessage, useIntl } from "react-intl";
import { setAppTargetPasteKeybind } from "../../actions/app-target.actions";
import { produceAppState, useAppStore } from "../../store";
import { StorageImage } from "../common/StorageImage";

export const AppKeybindingsDialog = () => {
  const open = useAppStore((state) => state.settings.appKeybindingsDialogOpen);
  const appTargets = useAppStore((state) => state.appTargetById);

  const sortedTargets = useMemo(
    () =>
      Object.values(appTargets).sort((a, b) =>
        (a.name ?? "").localeCompare(b.name ?? ""),
      ),
    [appTargets],
  );

  const handleClose = () => {
    produceAppState((draft) => {
      draft.settings.appKeybindingsDialogOpen = false;
    });
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <FormattedMessage defaultMessage="App Paste Bindings" />
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          <FormattedMessage defaultMessage="Different applications use different keyboard shortcuts for pasting. Select the keybind that works best for each app." />
        </Typography>
        {sortedTargets.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
            <FormattedMessage defaultMessage="No apps registered yet. Start dictating in an app and it will appear here." />
          </Typography>
        ) : (
          <>
            <Stack
              direction="row"
              justifyContent="space-between"
              sx={{ px: 1, mb: 1 }}
            >
              <Typography variant="caption" color="text.secondary">
                <FormattedMessage defaultMessage="App" />
              </Typography>
              <Typography variant="caption" color="text.secondary">
                <FormattedMessage defaultMessage="Paste keybind" />
              </Typography>
            </Stack>
            {sortedTargets.map((target) => (
              <AppKeybindingRow key={target.id} target={target} />
            ))}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>
          <FormattedMessage defaultMessage="Close" />
        </Button>
      </DialogActions>
    </Dialog>
  );
};

type AppKeybindingRowProps = {
  target: AppTarget;
};

const AppKeybindingRow = ({ target }: AppKeybindingRowProps) => {
  const intl = useIntl();
  const pasteKeybindValue = target.pasteKeybind ?? "ctrl+v";

  const handleChange = (event: SelectChangeEvent<string>) => {
    const value = event.target.value;
    void setAppTargetPasteKeybind(target.id, value === "ctrl+v" ? null : value);
  };

  return (
    <Stack
      direction="row"
      alignItems="center"
      justifyContent="space-between"
      sx={{ backgroundColor: "level1", mb: 1, borderRadius: 1, px: 1.5, py: 1 }}
    >
      <Stack
        direction="row"
        alignItems="center"
        spacing={1.5}
        sx={{ minWidth: 0 }}
      >
        <Box
          sx={{
            overflow: "hidden",
            borderRadius: 0.75,
            minWidth: 32,
            minHeight: 32,
            maxWidth: 32,
            maxHeight: 32,
            bgcolor: "level2",
            flexShrink: 0,
          }}
        >
          {target.iconPath && (
            <StorageImage
              path={target.iconPath}
              alt={
                target.name ??
                intl.formatMessage({ defaultMessage: "App icon" })
              }
              size={32}
            />
          )}
        </Box>
        <Typography variant="body2" noWrap>
          {target.name}
        </Typography>
      </Stack>
      <Select
        value={pasteKeybindValue}
        onChange={handleChange}
        size="small"
        variant="outlined"
        sx={{ minWidth: 170, flexShrink: 0 }}
      >
        <MenuItem value="ctrl+v">
          <FormattedMessage defaultMessage="Default (Ctrl+V)" />
        </MenuItem>
        <MenuItem value="ctrl+shift+v">
          <FormattedMessage defaultMessage="Terminal (Ctrl+Shift+V)" />
        </MenuItem>
      </Select>
    </Stack>
  );
};
