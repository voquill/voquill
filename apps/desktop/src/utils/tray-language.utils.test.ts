import type { Hotkey, User, UserPreferences } from "@voquill/types";
import { describe, expect, it } from "vitest";
import { AppState, INITIAL_APP_STATE } from "../state/app.state";
import { buildTrayLanguageMenuModel } from "./tray-language.utils";
import { LOCAL_USER_ID } from "./user.utils";

const additionalLanguageHotkey = (language: string): Hotkey => ({
  id: `hotkey-${language}`,
  actionName: `additional-language:${language}`,
  keys: ["KeyZ"],
});

const makeState = (args: {
  primaryLanguage?: string | null;
  activeDictationLanguage?: string | null;
  additionalLanguages?: string[];
}): AppState => {
  const hotkeyById: Record<string, Hotkey> = {};
  for (const language of args.additionalLanguages ?? []) {
    const hotkey = additionalLanguageHotkey(language);
    hotkeyById[hotkey.id] = hotkey;
  }

  return {
    ...INITIAL_APP_STATE,
    userById: {
      [LOCAL_USER_ID]: {
        preferredLanguage: args.primaryLanguage ?? null,
      } as User,
    },
    userPrefs: {
      activeDictationLanguage: args.activeDictationLanguage ?? null,
    } as UserPreferences,
    hotkeyById,
  };
};

const checkedCodes = (items: { code: string; checked: boolean }[]): string[] =>
  items.filter((item) => item.checked).map((item) => item.code);

describe("buildTrayLanguageMenuModel", () => {
  it("lists the primary follow entry, additional languages, and auto", () => {
    const items = buildTrayLanguageMenuModel(
      makeState({ primaryLanguage: "en", additionalLanguages: ["es", "fr"] }),
    );
    expect(items.map((item) => item.code)).toEqual([
      "primary",
      "es",
      "fr",
      "auto",
    ]);
  });

  it("renders the primary as the sentinel entry labelled with the language name", () => {
    const [primary] = buildTrayLanguageMenuModel(
      makeState({ primaryLanguage: "en" }),
    );
    expect(primary.code).toBe("primary");
    expect(primary.label).toBe("English");
  });

  it("checks the primary entry when following the primary", () => {
    const items = buildTrayLanguageMenuModel(
      makeState({
        primaryLanguage: "en",
        activeDictationLanguage: "primary",
        additionalLanguages: ["es"],
      }),
    );
    expect(checkedCodes(items)).toEqual(["primary"]);
  });

  it("checks the active concrete language", () => {
    const items = buildTrayLanguageMenuModel(
      makeState({
        primaryLanguage: "en",
        activeDictationLanguage: "es",
        additionalLanguages: ["es"],
      }),
    );
    expect(checkedCodes(items)).toEqual(["es"]);
  });

  it("checks auto when active", () => {
    const items = buildTrayLanguageMenuModel(
      makeState({ primaryLanguage: "en", activeDictationLanguage: "auto" }),
    );
    expect(checkedCodes(items)).toEqual(["auto"]);
  });

  it("always yields exactly one checked entry", () => {
    const items = buildTrayLanguageMenuModel(
      makeState({
        primaryLanguage: "en",
        activeDictationLanguage: "secondary",
        additionalLanguages: ["es", "fr"],
      }),
    );
    expect(checkedCodes(items)).toEqual(["primary"]);
  });

  it("does not render a duplicate auto row when the primary is itself auto", () => {
    const items = buildTrayLanguageMenuModel(
      makeState({
        primaryLanguage: "auto",
        activeDictationLanguage: "primary",
      }),
    );
    expect(items.map((item) => item.code)).toEqual(["primary"]);
    expect(items[0].label).toBe("Auto-detect");
    expect(checkedCodes(items)).toEqual(["primary"]);
  });

  it("keeps exactly one checked entry when the primary is auto and auto is active", () => {
    const items = buildTrayLanguageMenuModel(
      makeState({ primaryLanguage: "auto", activeDictationLanguage: "auto" }),
    );
    expect(items.map((item) => item.code)).toEqual(["primary"]);
    expect(checkedCodes(items)).toEqual(["primary"]);
  });

  it("still lists auto when the primary is keyboard-layout", () => {
    const items = buildTrayLanguageMenuModel(
      makeState({ primaryLanguage: "keyboard-layout" }),
    );
    expect(items.map((item) => item.code)).toEqual(["primary", "auto"]);
  });
});
