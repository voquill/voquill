import { describe, expect, it } from "vitest";
import { createDefaultPreferences } from "../actions/user.actions";
import { fromLocalPreferences, toLocalPreferences } from "./preferences.repo";

const localPrefsWithActiveLanguage = (
  activeDictationLanguage: string | null,
) => ({
  ...toLocalPreferences(createDefaultPreferences()),
  activeDictationLanguage,
});

describe("preferences round-trip", () => {
  it("preserves a non-primary active dictation language across load then save", () => {
    const loaded = fromLocalPreferences(localPrefsWithActiveLanguage("es"));
    expect(loaded.activeDictationLanguage).toBe("es");

    const saved = toLocalPreferences(loaded);
    expect(saved.activeDictationLanguage).toBe("es");
  });

  it("does not reset the active dictation language on an unrelated preference change", () => {
    const loaded = fromLocalPreferences(localPrefsWithActiveLanguage("es"));
    loaded.preferredMicrophone = "USB Microphone";

    const saved = toLocalPreferences(loaded);
    expect(saved.activeDictationLanguage).toBe("es");
    expect(saved.preferredMicrophone).toBe("USB Microphone");
  });

  it("writes the primary sentinel when no active dictation language is set", () => {
    const loaded = fromLocalPreferences(localPrefsWithActiveLanguage(null));
    expect(loaded.activeDictationLanguage).toBeNull();

    const saved = toLocalPreferences(loaded);
    expect(saved.activeDictationLanguage).toBe("primary");
  });
});
