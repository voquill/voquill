import { invoke } from "@tauri-apps/api/core";
import { AppState } from "../state/app.state";
import { useAppStore } from "../store";
import { getEffectiveStylingMode } from "./feature.utils";
import { getPlatform } from "./platform.utils";
import { getIsDictationUnlocked } from "./user.utils";

export const DICTATE_HOTKEY = "dictate";
export const AGENT_DICTATE_HOTKEY = "agent-dictate";
export const SWITCH_WRITING_STYLE_FORWARD_HOTKEY =
  "switch-writing-style-forward";
export const SWITCH_WRITING_STYLE_BACKWARD_HOTKEY =
  "switch-writing-style-backward";
export const CANCEL_TRANSCRIPTION_HOTKEY = "cancel-transcription";
export const ADD_TO_DICTIONARY_HOTKEY = "add-to-dictionary";
export const ADDITIONAL_LANGUAGE_HOTKEY_PREFIX = "additional-language:";

type CompositorBinding = {
  actionName: string;
  keys: string[];
};

const STATIC_COMPOSITOR_TRIGGER_ACTIONS = [
  DICTATE_HOTKEY,
  AGENT_DICTATE_HOTKEY,
  SWITCH_WRITING_STYLE_FORWARD_HOTKEY,
  SWITCH_WRITING_STYLE_BACKWARD_HOTKEY,
  CANCEL_TRANSCRIPTION_HOTKEY,
  ADD_TO_DICTIONARY_HOTKEY,
];

const isCompositorTriggerAction = (actionName: string): boolean =>
  STATIC_COMPOSITOR_TRIGGER_ACTIONS.includes(actionName) ||
  actionName.startsWith(ADDITIONAL_LANGUAGE_HOTKEY_PREFIX);

export const getAdditionalLanguageActionName = (language: string): string =>
  `${ADDITIONAL_LANGUAGE_HOTKEY_PREFIX}${language}`;

export const getAdditionalLanguageCode = (
  actionName: string,
): string | null => {
  if (!actionName.startsWith(ADDITIONAL_LANGUAGE_HOTKEY_PREFIX)) {
    return null;
  }

  const raw = actionName.slice(ADDITIONAL_LANGUAGE_HOTKEY_PREFIX.length);
  return raw.length > 0 ? raw : null;
};

export const isHoldActionHotkey = (actionName: string): boolean => {
  return (
    actionName === DICTATE_HOTKEY ||
    actionName === AGENT_DICTATE_HOTKEY ||
    actionName.startsWith(ADDITIONAL_LANGUAGE_HOTKEY_PREFIX)
  );
};

const isModifierLikeKey = (key: string): boolean => {
  const lower = key.toLowerCase();
  return (
    lower.startsWith("meta") ||
    lower.startsWith("control") ||
    lower.startsWith("shift") ||
    lower.startsWith("alt") ||
    lower.startsWith("option") ||
    lower.startsWith("function")
  );
};

export const isModifierOnlyCombo = (combo: string[]): boolean => {
  return combo.length > 0 && combo.every((key) => isModifierLikeKey(key));
};

export const getPrettyKeyName = (key: string): string => {
  const lower = key.toLowerCase();
  if (lower.startsWith("key")) {
    return key.slice(3).toUpperCase();
  }

  if (lower.startsWith("meta")) {
    return getPlatform() === "macos" ? "⌘" : "⊞";
  }

  if (lower.startsWith("control")) {
    return getPlatform() === "macos" ? "⌃" : "Ctrl";
  }

  if (lower.startsWith("shift")) {
    return getPlatform() === "macos" ? "⇧" : "Shift";
  }

  if (lower.startsWith("alt") || lower.startsWith("option")) {
    return getPlatform() === "macos" ? "⌥" : "Alt";
  }

  if (lower.startsWith("function")) {
    return "Fn";
  }

  if (key === "LeftArrow") return "←";
  if (key === "RightArrow") return "→";
  if (key === "UpArrow") return "↑";
  if (key === "DownArrow") return "↓";

  return key;
};

type PlatformHotkeyCombos = {
  macos: string[][];
  windows: string[][];
  linux: string[][];
};

export const DEFAULT_HOTKEY_COMBOS: Record<string, PlatformHotkeyCombos> = {
  [DICTATE_HOTKEY]: {
    macos: [["Function"]],
    windows: [["MetaLeft", "ControlLeft"]],
    linux: [["ControlLeft", "Space"]],
  },
  [CANCEL_TRANSCRIPTION_HOTKEY]: {
    macos: [["Escape"]],
    windows: [["Escape"]],
    linux: [["Escape"]],
  },
  [SWITCH_WRITING_STYLE_FORWARD_HOTKEY]: {
    macos: [["RightArrow"]],
    windows: [["RightArrow"]],
    linux: [["RightArrow"]],
  },
  [SWITCH_WRITING_STYLE_BACKWARD_HOTKEY]: {
    macos: [["LeftArrow"]],
    windows: [["LeftArrow"]],
    linux: [["LeftArrow"]],
  },
};

export const getHasDefaultHotkeyForAction = (actionName: string): boolean => {
  return Boolean(DEFAULT_HOTKEY_COMBOS[actionName]);
};

export const getDefaultHotkeyCombosForAction = (
  actionName: string,
): string[][] => {
  const defaultCombos = DEFAULT_HOTKEY_COMBOS[actionName];
  if (defaultCombos) {
    if (getPlatform() === "macos") {
      return defaultCombos.macos;
    } else if (getPlatform() === "windows") {
      return defaultCombos.windows;
    } else {
      return defaultCombos.linux;
    }
  }
  return [];
};

export const getHotkeyCombosForAction = (
  state: AppState,
  actionName: string,
): string[][] => {
  const combos = Object.values(state.hotkeyById)
    .filter((h) => h.actionName === actionName && h.keys.length > 0)
    .map((h) => h.keys);

  if (combos.length > 0) {
    return combos;
  }

  return getDefaultHotkeyCombosForAction(actionName);
};

export type AdditionalLanguageEntry = {
  actionName: string;
  language: string;
  hotkeyCombos: string[][];
};

export const getAdditionalLanguageEntries = (
  state: AppState,
): AdditionalLanguageEntry[] => {
  return Object.values(state.hotkeyById)
    .filter(
      (hotkey) =>
        hotkey &&
        hotkey.actionName.startsWith(ADDITIONAL_LANGUAGE_HOTKEY_PREFIX),
    )
    .map((hotkey) => {
      const language = getAdditionalLanguageCode(hotkey.actionName);
      if (!language) {
        return null;
      }
      return {
        actionName: hotkey.actionName,
        language,
        hotkeyCombos: getHotkeyCombosForAction(state, hotkey.actionName),
      };
    })
    .filter((entry): entry is AdditionalLanguageEntry => Boolean(entry));
};

/**
 * Fire-style shortcuts (cancel/switch style) are handled on key release in TS and should not
 * be natively grabbed, so shared shortcuts like Cmd+Z keep working.
 */
const isActionGrabbable = (state: AppState, actionName: string): boolean => {
  if (actionName === CANCEL_TRANSCRIPTION_HOTKEY) {
    return state.activeRecordingMode !== null;
  }

  if (
    actionName === SWITCH_WRITING_STYLE_FORWARD_HOTKEY ||
    actionName === SWITCH_WRITING_STYLE_BACKWARD_HOTKEY
  ) {
    return (
      state.activeRecordingMode !== null &&
      getEffectiveStylingMode(state) === "manual"
    );
  }

  if (actionName === DICTATE_HOTKEY || actionName === AGENT_DICTATE_HOTKEY) {
    return getIsDictationUnlocked(state);
  }

  return true;
};

export const syncHotkeyCombosToNative = async (): Promise<void> => {
  const state = useAppStore.getState();
  const actionNames = new Set<string>();

  for (const hotkey of Object.values(state.hotkeyById)) {
    if (hotkey.keys.length > 0) {
      actionNames.add(hotkey.actionName);
    }
  }

  for (const name of Object.keys(DEFAULT_HOTKEY_COMBOS)) {
    actionNames.add(name);
  }

  const combos: string[][] = [];
  const compositorBindings: CompositorBinding[] = [];

  for (const actionName of actionNames) {
    const actionCombos = getHotkeyCombosForAction(state, actionName);

    if (isActionGrabbable(state, actionName)) {
      for (const combo of actionCombos) {
        if (combo.length > 0) {
          // Modifier-only fire hotkeys (e.g. Cmd) must not be natively grabbed:
          // they need key-up handling so supersets like Cmd+Z still pass through.
          if (!isHoldActionHotkey(actionName) && isModifierOnlyCombo(combo)) {
            continue;
          }

          combos.push(combo);
        }
      }
    }

    if (
      isCompositorTriggerAction(actionName) &&
      isActionGrabbable(state, actionName) &&
      actionCombos.length > 0 &&
      actionCombos[0].length > 0 &&
      !isModifierOnlyCombo(actionCombos[0])
    ) {
      compositorBindings.push({
        actionName,
        keys: actionCombos[0],
      });
    }
  }

  try {
    await invoke("sync_hotkey_combos", { combos });
  } catch (err) {
    console.error("Failed to sync hotkey combos to native", err);
  }

  if (state.hotkeyStrategy === "bridge") {
    try {
      await invoke("sync_compositor_hotkeys", { bindings: compositorBindings });
    } catch (err) {
      console.error("Failed to sync compositor hotkeys", err);
    }
  }
};
