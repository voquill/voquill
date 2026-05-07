import { ArrowForward } from "@mui/icons-material";
import { Box, Button, Stack, Typography } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import { showErrorSnackbar } from "../../actions/app.actions";
import { goToOnboardingPage } from "../../actions/onboarding.actions";
import { getHotkeyRepo } from "../../repos";
import { produceAppState, useAppStore } from "../../store";
import { trackButtonClick } from "../../utils/analytics.utils";
import { registerHotkeys } from "../../utils/app.utils";
import { createId } from "../../utils/id.utils";
import {
  DICTATE_HOTKEY,
  getDefaultHotkeyCombosForAction,
  syncHotkeyCombosToNative,
} from "../../utils/keyboard.utils";
import { HotkeyBadge } from "../common/HotkeyBadge";
import { KeyPressSimulator } from "../common/KeyPressSimulator";
import {
  BackButton,
  DualPaneLayout,
  OnboardingFormLayout,
} from "./OnboardingCommon";

export const KeybindingsForm = () => {
  const [isListening, setIsListening] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const keysHeld = useAppStore((s) => s.keysHeld);
  const hotkeys = useAppStore((state) =>
    state.settings.hotkeyIds
      .map((id) => state.hotkeyById[id])
      .filter((hotkey) => hotkey?.actionName === DICTATE_HOTKEY),
  );

  const defaultCombos = getDefaultHotkeyCombosForAction(DICTATE_HOTKEY);
  const [primaryHotkey] = hotkeys;
  const currentKeys =
    primaryHotkey?.keys ?? (defaultCombos.length > 0 ? defaultCombos[0] : []);

  const lastEmittedRef = useRef<string[]>(currentKeys);
  const previousKeysHeldRef = useRef<string[]>([]);

  useEffect(() => {
    produceAppState((draft) => {
      draft.isRecordingHotkey = isListening;
    });
  }, [isListening]);

  useEffect(() => {
    if (!isListening) {
      previousKeysHeldRef.current = [];
      return;
    }

    const seen = new Set<string>();
    const held = keysHeld.filter((k: string) => {
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const previousHeld = previousKeysHeldRef.current;
    if (previousHeld.length > 0 && held.length < previousHeld.length) {
      setIsListening(false);
      previousKeysHeldRef.current = [];
      return;
    }

    previousKeysHeldRef.current = held;

    if (held.length === 0) return;

    if (held.length === 1 && held[0] === "Escape") {
      setIsListening(false);
      return;
    }

    const last = lastEmittedRef.current ?? [];
    const lastSet = new Set(last);
    const anyNewKey = held.some((k) => !lastSet.has(k));
    if (held.length > last.length || anyNewKey) {
      lastEmittedRef.current = held;
      void saveKey(held);
    }
  }, [keysHeld, isListening]);

  const saveKey = async (keys: string[]) => {
    const newValue = {
      id: primaryHotkey?.id ?? createId(),
      actionName: DICTATE_HOTKEY,
      keys,
    };

    try {
      produceAppState((draft) => {
        registerHotkeys(draft, [newValue]);
        if (!draft.settings.hotkeyIds.includes(newValue.id)) {
          draft.settings.hotkeyIds.push(newValue.id);
        }
        draft.settings.hotkeysStatus = "success";
      });
      await getHotkeyRepo().saveHotkey(newValue);
      await syncHotkeyCombosToNative();
    } catch (error) {
      console.error("Failed to save hotkey", error);
      showErrorSnackbar("Failed to save hotkey. Please try again.");
    }
  };

  const handleChangeShortcut = () => {
    trackButtonClick("onboarding_change_hotkey");
    lastEmittedRef.current = [];
    setIsListening(true);
    setTimeout(() => {
      boxRef.current?.focus();
    }, 0);
  };

  const handleConfirm = () => {
    trackButtonClick("onboarding_hotkey_works");
    goToOnboardingPage("micCheck");
  };

  const form = (
    <OnboardingFormLayout back={<BackButton />} actions={<div />}>
      <Stack spacing={2} pb={8}>
        <Typography variant="h4" fontWeight={600}>
          <FormattedMessage defaultMessage="Test your keyboard shortcut" />
        </Typography>
        <Typography variant="body1" color="text.secondary">
          <FormattedMessage
            defaultMessage="The {recommendedKey} key works great for most users."
            values={{
              recommendedKey: <HotkeyBadge keys={defaultCombos[0] ?? []} />,
            }}
          />
        </Typography>
      </Stack>
    </OnboardingFormLayout>
  );

  const handleBlur = (e: React.FocusEvent) => {
    if (boxRef.current?.contains(e.relatedTarget as Node)) {
      return;
    }
    setIsListening(false);
  };

  const rightContent = (
    <Stack
      ref={boxRef}
      tabIndex={0}
      onBlur={handleBlur}
      spacing={3}
      sx={{
        bgcolor: "level1",
        borderRadius: 2,
        p: 4,
        maxWidth: 400,
        outline: "none",
      }}
    >
      <Typography variant="h6" fontWeight={600}>
        {isListening ? (
          <FormattedMessage defaultMessage="Press your hotkey combo, then release" />
        ) : (
          <FormattedMessage defaultMessage="Does the key light up green when pressed?" />
        )}
      </Typography>

      <Box
        sx={{
          bgcolor: "level2",
          borderRadius: 2,
          p: 3,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          minHeight: 80,
          border: "2px solid",
          borderColor: isListening ? "primary.main" : "transparent",
          ...(isListening && {
            animation: "borderPulse 1s ease-in-out infinite",
          }),
          "@keyframes borderPulse": {
            "0%, 100%": {
              borderColor: "#1976d2",
            },
            "50%": {
              borderColor: "#90caf9",
            },
          },
        }}
      >
        {isListening ? (
          keysHeld.length > 0 ? (
            <KeyPressSimulator keys={keysHeld} />
          ) : (
            <Box
              sx={{
                height: 48,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Typography variant="body2" color="text.secondary">
                <FormattedMessage defaultMessage="Press your new key combo..." />
              </Typography>
            </Box>
          )
        ) : (
          <KeyPressSimulator keys={currentKeys} />
        )}
      </Box>

      <Stack direction="row" spacing={2} justifyContent="flex-end">
        <Button
          variant="text"
          onClick={handleChangeShortcut}
          disabled={isListening}
        >
          <FormattedMessage defaultMessage="Change hotkey" />
        </Button>
        <Button
          variant="contained"
          onClick={handleConfirm}
          endIcon={<ArrowForward />}
          disabled={isListening}
        >
          <FormattedMessage defaultMessage="It works" />
        </Button>
      </Stack>
    </Stack>
  );

  return (
    <DualPaneLayout
      flex={[2, 3]}
      left={form}
      right={rightContent}
      rightSx={{ bgcolor: "transparent" }}
    />
  );
};
