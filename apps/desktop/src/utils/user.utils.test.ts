import type { Hotkey, User, UserPreferences } from "@voquill/types";
import { describe, expect, it } from "vitest";
import { AppState, INITIAL_APP_STATE } from "../state/app.state";
import {
  getActiveDictationLanguage,
  getConfiguredDictationLanguageCodes,
  getMyDictationLanguage,
  LOCAL_USER_ID,
} from "./user.utils";

const additionalLanguageHotkey = (language: string): Hotkey => ({
  id: `hotkey-${language}`,
  actionName: `additional-language:${language}`,
  keys: ["KeyZ"],
});

const makeState = (args: {
  primaryLanguage?: string | null;
  activeDictationLanguage?: string | null;
  additionalLanguages?: string[];
  override?: string | null;
}): AppState => {
  const hotkeyById: Record<string, Hotkey> = {};
  for (const language of args.additionalLanguages ?? []) {
    const hotkey = additionalLanguageHotkey(language);
    hotkeyById[hotkey.id] = hotkey;
  }

  return {
    ...INITIAL_APP_STATE,
    dictationLanguageOverride: args.override ?? null,
    userById: {
      [LOCAL_USER_ID]: {
        preferredLanguage: args.primaryLanguage ?? null,
      } as User,
    },
    userPrefs:
      args.activeDictationLanguage === undefined
        ? null
        : ({
            activeDictationLanguage: args.activeDictationLanguage,
          } as UserPreferences),
    hotkeyById,
  };
};

describe("getConfiguredDictationLanguageCodes", () => {
  it("always includes auto", () => {
    const codes = getConfiguredDictationLanguageCodes(makeState({}));
    expect(codes.has("auto")).toBe(true);
  });

  it("includes additional configured languages", () => {
    const codes = getConfiguredDictationLanguageCodes(
      makeState({ additionalLanguages: ["es", "fr"] }),
    );
    expect(codes.has("es")).toBe(true);
    expect(codes.has("fr")).toBe(true);
  });

  it("does not include the primary concrete code", () => {
    const codes = getConfiguredDictationLanguageCodes(
      makeState({ primaryLanguage: "en" }),
    );
    expect(codes.has("en")).toBe(false);
  });
});

describe("getActiveDictationLanguage", () => {
  it("returns the sentinel when unset", () => {
    expect(getActiveDictationLanguage(makeState({}))).toBe("primary");
  });

  it("returns the sentinel when explicitly set to primary", () => {
    expect(
      getActiveDictationLanguage(
        makeState({ activeDictationLanguage: "primary" }),
      ),
    ).toBe("primary");
  });

  it("honors a configured concrete code", () => {
    expect(
      getActiveDictationLanguage(
        makeState({
          activeDictationLanguage: "es",
          additionalLanguages: ["es"],
        }),
      ),
    ).toBe("es");
  });

  it("falls through to the sentinel for a stale value not in the configured set", () => {
    expect(
      getActiveDictationLanguage(
        makeState({ activeDictationLanguage: "secondary" }),
      ),
    ).toBe("primary");
  });

  it("falls through to the sentinel when the active language was removed from the set", () => {
    expect(
      getActiveDictationLanguage(
        makeState({
          activeDictationLanguage: "es",
          additionalLanguages: ["fr"],
        }),
      ),
    ).toBe("primary");
  });

  it("honors auto since it is always configured", () => {
    expect(
      getActiveDictationLanguage(
        makeState({ activeDictationLanguage: "auto" }),
      ),
    ).toBe("auto");
  });
});

describe("getMyDictationLanguage", () => {
  it("lets a transient override take precedence over the active language", () => {
    const state = makeState({
      primaryLanguage: "en",
      activeDictationLanguage: "es",
      additionalLanguages: ["es"],
      override: "fr",
    });
    expect(getMyDictationLanguage(state)).toBe("fr");
  });

  it("uses the active language over the primary", () => {
    const state = makeState({
      primaryLanguage: "en",
      activeDictationLanguage: "es",
      additionalLanguages: ["es"],
    });
    expect(getMyDictationLanguage(state)).toBe("es");
  });

  it("follows the primary when the active language is the sentinel", () => {
    const state = makeState({
      primaryLanguage: "en",
      activeDictationLanguage: "primary",
    });
    expect(getMyDictationLanguage(state)).toBe("en");
  });

  it("follows the primary for a stale value (upgrade safety)", () => {
    const state = makeState({
      primaryLanguage: "en",
      activeDictationLanguage: "secondary",
    });
    expect(getMyDictationLanguage(state)).toBe("en");
  });

  it("passes auto through as the active language", () => {
    const state = makeState({
      primaryLanguage: "en",
      activeDictationLanguage: "auto",
    });
    expect(getMyDictationLanguage(state)).toBe("auto");
  });

  it("passes a keyboard-layout primary through when following the primary", () => {
    const state = makeState({
      primaryLanguage: "keyboard-layout",
      activeDictationLanguage: "primary",
    });
    expect(getMyDictationLanguage(state)).toBe("keyboard-layout");
  });
});
