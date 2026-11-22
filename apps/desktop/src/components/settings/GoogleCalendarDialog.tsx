import { Google } from "@mui/icons-material";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  Typography,
} from "@mui/material";
import { useEffect } from "react";
import { FormattedMessage } from "react-intl";
import {
  linkGoogleCalendarAccount,
  loadCalendars,
  setCalendarLinked,
  unlinkCalendarAccount,
} from "../../actions/calendar.actions";
import { produceAppState, useAppStore } from "../../store";
import type { Calendar } from "../../types/calendar.types";

type CalendarAccountSectionProps = {
  accountId: string;
};

const CalendarAccountSection = ({ accountId }: CalendarAccountSectionProps) => {
  const account = useAppStore((state) => state.calendarAccountById[accountId]);
  const calendars = useAppStore(
    (state) => state.calendar.calendarsByAccountId[accountId],
  );
  const calendarsStatus = useAppStore(
    (state) => state.calendar.calendarsStatusByAccountId[accountId],
  );
  const reauthRequired = useAppStore(
    (state) => state.calendar.reauthRequiredByAccountId[accountId] ?? false,
  );

  useEffect(() => {
    void loadCalendars(accountId);
  }, [accountId]);

  if (!account) return null;

  const renderCalendar = (calendar: Calendar) => (
    <FormControlLabel
      key={calendar.id}
      sx={{ mr: 0 }}
      control={
        <Checkbox
          size="small"
          checked={account.linkedCalendarIds.includes(calendar.id)}
          onChange={(event) =>
            void setCalendarLinked(accountId, calendar.id, event.target.checked)
          }
        />
      }
      label={
        <Stack direction="row" alignItems="center" spacing={1}>
          <Box
            sx={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              flexShrink: 0,
              bgcolor: calendar.color ?? "text.disabled",
            }}
          />
          <Typography variant="body2">{calendar.name}</Typography>
        </Stack>
      }
    />
  );

  let body: React.ReactNode;
  if (reauthRequired) {
    body = (
      <Alert
        severity="warning"
        action={
          <Button
            color="inherit"
            size="small"
            sx={{ whiteSpace: "nowrap" }}
            onClick={() => void linkGoogleCalendarAccount()}
          >
            <FormattedMessage defaultMessage="Link again" />
          </Button>
        }
      >
        <FormattedMessage defaultMessage="Voquill no longer has access to this account, so its events have no reminders." />
      </Alert>
    );
  } else if (calendars) {
    body = <Stack>{calendars.map(renderCalendar)}</Stack>;
  } else if (calendarsStatus === "error") {
    body = (
      <Alert
        severity="error"
        action={
          <Button
            color="inherit"
            size="small"
            onClick={() => void loadCalendars(accountId)}
          >
            <FormattedMessage defaultMessage="Retry" />
          </Button>
        }
      >
        <FormattedMessage defaultMessage="The calendars for this account could not be loaded." />
      </Alert>
    );
  } else {
    body = <CircularProgress size={20} sx={{ my: 1 }} />;
  }

  return (
    <Stack spacing={0.5}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="body1" fontWeight={600} noWrap>
          {account.email ?? (
            <FormattedMessage defaultMessage="Google account" />
          )}
        </Typography>
        <Button
          size="small"
          color="inherit"
          onClick={() => void unlinkCalendarAccount(accountId)}
        >
          <FormattedMessage defaultMessage="Unlink" />
        </Button>
      </Stack>
      {body}
    </Stack>
  );
};

export const GoogleCalendarDialog = () => {
  const open = useAppStore((state) => state.settings.googleCalendarDialogOpen);
  const accountIds = useAppStore((state) => state.calendar.accountIds);
  const linking = useAppStore(
    (state) => state.calendar.linkStatus === "loading",
  );

  const handleClose = () => {
    produceAppState((draft) => {
      draft.settings.googleCalendarDialogOpen = false;
    });
  };

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="xs">
      <DialogTitle>
        <FormattedMessage defaultMessage="Google Calendar" />
      </DialogTitle>
      <DialogContent>
        <Stack spacing={3}>
          <Typography variant="body2" color="text.secondary">
            <FormattedMessage defaultMessage="One minute before an event starts on a linked calendar, Voquill shows a reminder at the top right of your screen. All-day events and events you declined are skipped." />
          </Typography>
          {open &&
            accountIds.map((accountId) => (
              <CalendarAccountSection key={accountId} accountId={accountId} />
            ))}
          {linking && (
            <Typography variant="body2" color="text.secondary">
              <FormattedMessage defaultMessage="Finish linking in your browser." />
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button
          startIcon={<Google />}
          loading={linking}
          onClick={() => void linkGoogleCalendarAccount()}
        >
          <FormattedMessage defaultMessage="Link Google account" />
        </Button>
        <Button onClick={handleClose}>
          <FormattedMessage defaultMessage="Done" />
        </Button>
      </DialogActions>
    </Dialog>
  );
};
