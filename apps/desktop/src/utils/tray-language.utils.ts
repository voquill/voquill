import type { AppState } from "../state/app.state";
import { getAdditionalLanguageEntries } from "./keyboard.utils";
import {
  AUTO_LANGUAGE,
  DICTATION_LANGUAGE_OPTIONS,
  getDisplayNameForLanguage,
  PRIMARY_LANGUAGE_SENTINEL,
} from "./language.utils";
import {
  getActiveDictationLanguage,
  getMyPrimaryDictationLanguage,
} from "./user.utils";

export type TrayLanguageMenuItem = {
  code: string;
  label: string;
  checked: boolean;
};

const getDictationLanguageLabel = (code: string): string => {
  const option = DICTATION_LANGUAGE_OPTIONS.find(([value]) => value === code);
  return option ? option[1] : getDisplayNameForLanguage(code);
};

/**
 * Maps app state to the tray Language submenu model: the Primary (rendered as
 * the `primary` follow entry), each additional configured language, and Auto.
 * Deduplicates by code so a Primary that is itself `auto`/`keyboard-layout`
 * does not produce a duplicate row, and yields exactly one checked entry
 * tracking the Active Dictation Language.
 */
export const buildTrayLanguageMenuModel = (
  state: AppState,
): TrayLanguageMenuItem[] => {
  const primaryCode = getMyPrimaryDictationLanguage(state);
  const active = getActiveDictationLanguage(state);
  const checkedCode =
    active === PRIMARY_LANGUAGE_SENTINEL || active === primaryCode
      ? PRIMARY_LANGUAGE_SENTINEL
      : active;

  const items: TrayLanguageMenuItem[] = [];
  const seen = new Set<string>();

  items.push({
    code: PRIMARY_LANGUAGE_SENTINEL,
    label: getDictationLanguageLabel(primaryCode),
    checked: checkedCode === PRIMARY_LANGUAGE_SENTINEL,
  });
  seen.add(primaryCode);

  for (const entry of getAdditionalLanguageEntries(state)) {
    if (seen.has(entry.language)) {
      continue;
    }
    seen.add(entry.language);
    items.push({
      code: entry.language,
      label: getDictationLanguageLabel(entry.language),
      checked: checkedCode === entry.language,
    });
  }

  if (!seen.has(AUTO_LANGUAGE)) {
    items.push({
      code: AUTO_LANGUAGE,
      label: getDictationLanguageLabel(AUTO_LANGUAGE),
      checked: checkedCode === AUTO_LANGUAGE,
    });
  }

  return items;
};
