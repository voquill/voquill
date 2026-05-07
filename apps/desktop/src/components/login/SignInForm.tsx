import {
  Button,
  Divider,
  IconButton,
  Link,
  Stack,
  TextField,
} from "@mui/material";
import { FormattedMessage } from "react-intl";
import { OidcProviders } from "./OidcProviders";
import { setMode, submitSignIn } from "../../actions/login.actions";
import { produceAppState, useAppStore } from "../../store";
import {
  getCanSubmitLogin,
  getShouldShowEmailForm,
} from "../../utils/login.utils";
import { useState } from "react";
import { Visibility, VisibilityOff } from "@mui/icons-material";

type SignInFormProps = {
  hideOidcProviders?: boolean;
};

export const SignInForm = ({ hideOidcProviders = false }: SignInFormProps) => {
  const [passwordVisible, setPasswordVisible] = useState(false);

  const email = useAppStore((state) => state.login.email);
  const password = useAppStore((state) => state.login.password);
  const canSubmit = useAppStore((state) => getCanSubmitLogin(state));
  const showEmailForm = useAppStore((state) => getShouldShowEmailForm(state));

  const handleClickReset = () => {
    setMode("resetPassword");
  };

  const handleClickRegister = () => {
    setMode("signUp");
  };

  const handleChangeEmail = (event: React.ChangeEvent<HTMLInputElement>) => {
    produceAppState((state) => {
      state.login.email = event.target.value;
    });
  };

  const handleChangePassword = (event: React.ChangeEvent<HTMLInputElement>) => {
    produceAppState((state) => {
      state.login.password = event.target.value;
    });
  };

  const handleSubmit = async () => {
    await submitSignIn();
  };

  return (
    <Stack spacing={2}>
      {!hideOidcProviders && <OidcProviders />}

      {showEmailForm && (
        <>
          {!hideOidcProviders && (
            <Divider>
              <FormattedMessage defaultMessage="or" />
            </Divider>
          )}

          <TextField
            label={<FormattedMessage defaultMessage="Email" />}
            type="email"
            fullWidth
            value={email}
            onChange={handleChangeEmail}
            size="small"
          />
          <TextField
            label={<FormattedMessage defaultMessage="Password" />}
            type={passwordVisible ? "text" : "password"}
            fullWidth
            value={password}
            onChange={handleChangePassword}
            size="small"
            InputProps={{
              endAdornment: (
                <IconButton
                  onClick={() => setPasswordVisible((v) => !v)}
                  tabIndex={-1}
                  size="small"
                >
                  {!passwordVisible ? <VisibilityOff /> : <Visibility />}
                </IconButton>
              ),
            }}
          />

          <Button
            variant="contained"
            fullWidth
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            <FormattedMessage defaultMessage="Log in" />
          </Button>

          <Stack direction="row" justifyContent="space-between" spacing={1}>
            <Link component="button" onClick={handleClickReset}>
              <FormattedMessage defaultMessage="Forgot?" />
            </Link>
            <Link component="button" onClick={handleClickRegister}>
              <FormattedMessage defaultMessage="Create account" />
            </Link>
          </Stack>
        </>
      )}
    </Stack>
  );
};
