import {
  AppsOutlined,
  ArrowOutwardRounded,
  AutoAwesomeOutlined,
  AutoFixHighOutlined,
  DeleteForeverOutlined,
  DescriptionOutlined,
  Edit,
  GraphicEqOutlined,
  KeyboardAltOutlined,
  LanguageOutlined,
  LockOutlined,
  LogoutOutlined,
  MicOutlined,
  MoreVertOutlined,
  PaymentOutlined,
  PersonRemoveOutlined,
  PrivacyTipOutlined,
  RocketLaunchOutlined,
  TroubleshootOutlined,
  VolumeUpOutlined,
  WarningAmberOutlined,
} from "@mui/icons-material";
import {
  Box,
  Button,
  Chip,
  IconButton,
  Link,
  MenuItem,
  Select,
  SelectChangeEvent,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from "@mui/material";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChangeEvent, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { showErrorSnackbar } from "../../actions/app.actions";
import { setAutoLaunchEnabled } from "../../actions/settings.actions";
import { loadTones } from "../../actions/tone.actions";
import { setPreferredLanguage } from "../../actions/user.actions";
import { getAuthRepo, getStripeRepo } from "../../repos";
import {
  getSignOutStopsMeeting,
  stopMeetingNote,
} from "../../actions/note.actions";
import { getAppState, produceAppState, useAppStore } from "../../store";
import {
  getAllowsChangePostProcessing,
  getAllowsChangeTranscription,
} from "../../utils/enterprise.utils";
import { getAdditionalLanguageEntries } from "../../utils/keyboard.utils";
import {
  DICTATION_LANGUAGE_OPTIONS,
  KEYBOARD_LAYOUT_LANGUAGE,
  WHISPER_LANGUAGES,
} from "../../utils/language.utils";
import { getIsPaidSubscriber } from "../../utils/member.utils";
import {
  getDetectedSystemLocale,
  getGenerativePrefs,
  getHasEmailProvider,
  getIsSignedIn,
  getMyUser,
} from "../../utils/user.utils";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { ListTile } from "../common/ListTile";
import { Section } from "../common/Section";
import { DashboardEntryLayout } from "../dashboard/DashboardEntryLayout";

export default function SettingsPage() {
  const hasEmailProvider = useAppStore(getHasEmailProvider);
  const isSubscribed = useAppStore(getIsPaidSubscriber);
  const isEnterprise = useAppStore((state) => state.isEnterprise);
  const allowChangeTranscription = useAppStore(getAllowsChangeTranscription);
  const allowChangePostProcessing = useAppStore(getAllowsChangePostProcessing);
  const [manageSubscriptionLoading, setManageSubscriptionLoading] =
    useState(false);
  const isSignedIn = useAppStore(getIsSignedIn);
  const [autoLaunchEnabled, autoLaunchStatus] = useAppStore((state) => [
    state.settings.autoLaunchEnabled,
    state.settings.autoLaunchStatus,
  ]);
  const autoLaunchLoading = autoLaunchStatus === "loading";
  const intl = useIntl();

  const dictationLanguage = useAppStore((state) => {
    const user = getMyUser(state);
    return user?.preferredLanguage ?? getDetectedSystemLocale();
  });

  const dictationLanguageWarning = useAppStore((state) => {
    const hasPostProcessingEnabled = getGenerativePrefs(state).mode !== "none";
    if (hasPostProcessingEnabled) {
      return null;
    }

    if (dictationLanguage === KEYBOARD_LAYOUT_LANGUAGE) {
      return null;
    }

    const isWhisperLang = dictationLanguage in WHISPER_LANGUAGES;
    if (!isWhisperLang) {
      return intl.formatMessage({
        defaultMessage:
          "Be sure to enable AI post processing when using this language for the best results.",
      });
    }

    return null;
  });

  const hasAdditionalLanguages = useAppStore(
    (state) => getAdditionalLanguageEntries(state).length > 0,
  );

  const openDictationLanguageDialog = () => {
    produceAppState((draft) => {
      draft.settings.dictationLanguageDialogOpen = true;
    });
  };

  const handleDictationLanguageChange = (event: SelectChangeEvent<string>) => {
    const nextValue = event.target.value;
    void setPreferredLanguage(nextValue).then(() => {
      loadTones();
    });
  };

  const openChangePasswordDialog = () => {
    produceAppState((state) => {
      state.settings.changePasswordDialogOpen = true;
    });
  };

  const openTranscriptionDialog = () => {
    produceAppState((draft) => {
      draft.settings.aiTranscriptionDialogOpen = true;
    });
  };

  const openPostProcessingDialog = () => {
    produceAppState((draft) => {
      draft.settings.aiPostProcessingDialogOpen = true;
    });
  };

  const openAppKeybindingsDialog = () => {
    produceAppState((draft) => {
      draft.settings.appKeybindingsDialogOpen = true;
    });
  };

  const openAgentModeDialog = () => {
    produceAppState((draft) => {
      draft.settings.agentModeDialogOpen = true;
    });
  };

  const openMicrophoneDialog = () => {
    produceAppState((draft) => {
      draft.settings.microphoneDialogOpen = true;
    });
  };

  const openAudioDialog = () => {
    produceAppState((draft) => {
      draft.settings.audioDialogOpen = true;
    });
  };

  const openDiagnosticsDialog = () => {
    produceAppState((draft) => {
      draft.settings.diagnosticsDialogOpen = true;
    });
  };

  const openShortcutsDialog = () => {
    produceAppState((draft) => {
      draft.settings.shortcutsDialogOpen = true;
    });
  };

  const openMoreSettingsDialog = () => {
    produceAppState((draft) => {
      draft.settings.moreSettingsDialogOpen = true;
    });
  };

  const openClearLocalDataDialog = () => {
    produceAppState((draft) => {
      draft.settings.clearLocalDataDialogOpen = true;
    });
  };

  const openDeleteAccountDialog = () => {
    produceAppState((state) => {
      state.settings.deleteAccountDialog = true;
    });
  };

  const handleToggleAutoLaunch = (event: ChangeEvent<HTMLInputElement>) => {
    const enabled = event.target.checked;
    void setAutoLaunchEnabled(enabled);
  };

  const handleManageSubscription = async () => {
    setManageSubscriptionLoading(true);
    try {
      const url = await getStripeRepo()?.createCustomerPortalSession();
      if (url) {
        openUrl(url);
      } else {
        showErrorSnackbar("Unable to open manage subscription page.");
      }
    } catch (error) {
      showErrorSnackbar(error);
    } finally {
      setManageSubscriptionLoading(false);
    }
  };

  const [confirmSignOut, setConfirmSignOut] = useState(false);

  const signOutNow = async () => {
    await getAuthRepo().signOut();
  };

  const handleSignOut = async () => {
    if (getSignOutStopsMeeting()) {
      setConfirmSignOut(true);
      return;
    }
    await signOutNow();
  };

  const handleConfirmSignOut = async () => {
    setConfirmSignOut(false);
    const activeNoteId = getAppState().notes.activeNoteId;
    try {
      if (activeNoteId) {
        await stopMeetingNote(activeNoteId);
      }
      await signOutNow();
    } catch (error) {
      showErrorSnackbar(error);
    }
  };

  const general = (
    <Section title={<FormattedMessage defaultMessage="General" />}>
      <ListTile
        title={<FormattedMessage defaultMessage="Start on system startup" />}
        leading={<RocketLaunchOutlined />}
        disableRipple={true}
        trailing={
          <Switch
            edge="end"
            checked={autoLaunchEnabled}
            disabled={autoLaunchLoading}
            onChange={handleToggleAutoLaunch}
          />
        }
      />
      <ListTile
        title={<FormattedMessage defaultMessage="Microphone" />}
        leading={<MicOutlined />}
        onClick={openMicrophoneDialog}
      />
      <ListTile
        title={<FormattedMessage defaultMessage="Audio" />}
        leading={<VolumeUpOutlined />}
        onClick={openAudioDialog}
      />
      <ListTile
        title={<FormattedMessage defaultMessage="Hotkey shortcuts" />}
        leading={<KeyboardAltOutlined />}
        onClick={openShortcutsDialog}
      />
      <ListTile
        title={<FormattedMessage defaultMessage="Diagnostics" />}
        leading={<TroubleshootOutlined />}
        onClick={openDiagnosticsDialog}
      />
      <ListTile
        title={<FormattedMessage defaultMessage="Text insertion options" />}
        leading={<AppsOutlined />}
        onClick={openAppKeybindingsDialog}
      />
      <ListTile
        title={<FormattedMessage defaultMessage="More settings" />}
        leading={<MoreVertOutlined />}
        onClick={openMoreSettingsDialog}
      />
    </Section>
  );

  const dictationLanguageComp = (
    <>
      {hasAdditionalLanguages ? (
        <ListTile
          title={<FormattedMessage defaultMessage="Dictation language" />}
          leading={<LanguageOutlined />}
          onClick={openDictationLanguageDialog}
          trailing={
            <Button
              variant="outlined"
              size="small"
              endIcon={<Edit sx={{ fontSize: 16 }} />}
              onClick={openDictationLanguageDialog}
              sx={{ textTransform: "none", py: 0.5, px: 1.5, fontWeight: 400 }}
            >
              <FormattedMessage defaultMessage="Multiple languages" />
            </Button>
          }
        />
      ) : (
        <ListTile
          title={<FormattedMessage defaultMessage="Dictation language" />}
          leading={<LanguageOutlined />}
          disableRipple={true}
          trailing={
            <Box
              onClick={(event) => event.stopPropagation()}
              sx={{
                minWidth: 200,
                display: "flex",
                alignItems: "center",
                gap: 1,
              }}
            >
              {dictationLanguageWarning && (
                <Tooltip
                  title={
                    <Box>
                      {dictationLanguageWarning}{" "}
                      <Link
                        component="button"
                        color="inherit"
                        sx={{ verticalAlign: "baseline" }}
                        onClick={openPostProcessingDialog}
                      >
                        <FormattedMessage defaultMessage="Fix issue" />
                      </Link>
                    </Box>
                  }
                  slotProps={{
                    popper: {
                      modifiers: [
                        { name: "offset", options: { offset: [0, -8] } },
                      ],
                    },
                  }}
                >
                  <WarningAmberOutlined color="warning" fontSize="small" />
                </Tooltip>
              )}
              <Tooltip
                title={
                  <FormattedMessage defaultMessage="Set up multiple languages with different hotkeys" />
                }
              >
                <IconButton size="small" onClick={openDictationLanguageDialog}>
                  <MoreVertOutlined fontSize="small" />
                </IconButton>
              </Tooltip>
              <Select
                value={dictationLanguage}
                onChange={handleDictationLanguageChange}
                size="small"
                variant="outlined"
                fullWidth
                inputProps={{ "aria-label": "Dictation language" }}
                MenuProps={{
                  PaperProps: {
                    style: {
                      maxHeight: 300,
                    },
                  },
                }}
              >
                {DICTATION_LANGUAGE_OPTIONS.map(([value, label]) => (
                  <MenuItem key={value} value={value}>
                    {label}
                  </MenuItem>
                ))}
              </Select>
            </Box>
          }
        />
      )}
    </>
  );

  const processing = (
    <Section
      title={<FormattedMessage defaultMessage="Processing" />}
      description={
        <FormattedMessage defaultMessage="How Voquill should manage your transcriptions." />
      }
    >
      {dictationLanguageComp}
      {allowChangeTranscription && (
        <ListTile
          title={<FormattedMessage defaultMessage="AI transcription" />}
          leading={<GraphicEqOutlined />}
          onClick={openTranscriptionDialog}
        />
      )}
      {allowChangePostProcessing && (
        <ListTile
          title={<FormattedMessage defaultMessage="AI post processing" />}
          leading={<AutoFixHighOutlined />}
          onClick={openPostProcessingDialog}
        />
      )}
      {!isEnterprise && (
        <ListTile
          title={
            <Stack direction="row" alignItems="center">
              <FormattedMessage defaultMessage="Assistant mode" />
              <Chip label="Beta" size="small" color="primary" sx={{ ml: 1 }} />
            </Stack>
          }
          leading={<AutoAwesomeOutlined />}
          onClick={openAgentModeDialog}
        />
      )}
    </Section>
  );

  const advanced = (
    <Section
      title={<FormattedMessage defaultMessage="Advanced" />}
      description={
        <FormattedMessage defaultMessage="Manage your account preferences and settings." />
      }
    >
      {hasEmailProvider && (
        <ListTile
          title={<FormattedMessage defaultMessage="Change password" />}
          leading={<LockOutlined />}
          onClick={openChangePasswordDialog}
        />
      )}
      {isSubscribed && !isEnterprise && (
        <ListTile
          title={<FormattedMessage defaultMessage="Manage subscription" />}
          leading={<PaymentOutlined />}
          onClick={handleManageSubscription}
          disabled={manageSubscriptionLoading}
          trailing={<ArrowOutwardRounded />}
        />
      )}
      <ListTile
        title={<FormattedMessage defaultMessage="Terms & conditions" />}
        onClick={() => openUrl("https://voquill.com/terms")}
        trailing={<ArrowOutwardRounded />}
        leading={<DescriptionOutlined />}
      />
      <ListTile
        title={<FormattedMessage defaultMessage="Privacy policy" />}
        onClick={() => openUrl("https://voquill.com/privacy")}
        trailing={<ArrowOutwardRounded />}
        leading={<PrivacyTipOutlined />}
      />
      {isSignedIn && (
        <ListTile
          title={<FormattedMessage defaultMessage="Sign out" />}
          leading={<LogoutOutlined />}
          onClick={handleSignOut}
        />
      )}
    </Section>
  );

  const dangerZone = (
    <Section
      title={<FormattedMessage defaultMessage="Danger zone" />}
      description={
        <FormattedMessage defaultMessage="Be careful with these actions. They can have significant consequences for your account." />
      }
    >
      {!isSignedIn && (
        <ListTile
          title={<FormattedMessage defaultMessage="Clear local data" />}
          leading={<DeleteForeverOutlined />}
          onClick={openClearLocalDataDialog}
        />
      )}
      {isSignedIn && (
        <ListTile
          sx={{ mt: 1 }}
          title={<FormattedMessage defaultMessage="Delete account" />}
          leading={<PersonRemoveOutlined />}
          onClick={openDeleteAccountDialog}
        />
      )}
    </Section>
  );

  return (
    <DashboardEntryLayout>
      <Stack direction="column">
        <Typography variant="h4" fontWeight={700} sx={{ marginBottom: 4 }}>
          <FormattedMessage defaultMessage="Settings" />
        </Typography>
        {general}
        {processing}
        {advanced}
        {!isEnterprise && dangerZone}
      </Stack>
      <ConfirmDialog
        isOpen={confirmSignOut}
        title={
          <FormattedMessage defaultMessage="Stop the meeting and sign out?" />
        }
        content={
          <FormattedMessage defaultMessage="The meeting being recorded belongs to your Voquill account. Signing out stops the recording. Everything recorded so far is saved on this device, and the notes are written when you sign in again." />
        }
        confirmLabel={<FormattedMessage defaultMessage="Stop and sign out" />}
        onCancel={() => setConfirmSignOut(false)}
        onConfirm={handleConfirmSignOut}
      />
    </DashboardEntryLayout>
  );
}
