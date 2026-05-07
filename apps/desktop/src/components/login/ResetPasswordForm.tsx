import { ArrowBack } from "@mui/icons-material";
import { Button, Stack, TextField, Typography } from "@mui/material";
import { FormattedMessage } from "react-intl";
import { setMode, submitResetPassword } from "../../actions/login.actions";
import { produceAppState, useAppStore } from "../../store";
import { getCanSubmitResetPassword } from "../../utils/login.utils";

export const ResetPasswordForm = () => {
  const isEnterprise = useAppStore((state) => state.isEnterprise);
  const email = useAppStore((state) => state.login.email);
  const canSubmit = useAppStore((state) => getCanSubmitResetPassword(state));

  const handleClickBack = () => {
    setMode("signIn");
  };

  const handleChangeEmail = (event: React.ChangeEvent<HTMLInputElement>) => {
    produceAppState((state) => {
      state.login.email = event.target.value;
    });
  };

  const handleSubmit = async () => {
    await submitResetPassword();
  };

  if (isEnterprise) {
    return (
      <Stack spacing={2} alignItems="center">
        <Typography variant="body2">
          <FormattedMessage defaultMessage="Contact your administrator to reset your password. They can either reset your password or delete your account and have you create a new one." />
        </Typography>
        <Button
          size="small"
          startIcon={<ArrowBack />}
          onClick={handleClickBack}
        >
          <FormattedMessage defaultMessage="Back" />
        </Button>
      </Stack>
    );
  }

  return (
    <Stack spacing={2} alignItems="center">
      <Typography textAlign="center" variant="body2">
        <FormattedMessage defaultMessage="Enter your email and we'll send a reset link." />
      </Typography>
      <TextField
        label={<FormattedMessage defaultMessage="Email" />}
        type="email"
        fullWidth
        value={email}
        onChange={handleChangeEmail}
        size="small"
      />
      <Button
        variant="contained"
        fullWidth
        disabled={!canSubmit}
        onClick={handleSubmit}
      >
        <FormattedMessage defaultMessage="Send reset link" />
      </Button>
      <Button size="small" startIcon={<ArrowBack />} onClick={handleClickBack}>
        <FormattedMessage defaultMessage="Back" />
      </Button>
    </Stack>
  );
};
