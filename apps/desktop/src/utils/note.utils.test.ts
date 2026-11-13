import type { Member } from "@voquill/types";
import { describe, expect, it } from "vitest";
import { INITIAL_APP_STATE, type AppState } from "../state/app.state";
import { selectNoteStorage } from "./note.utils";

const stateWith = ({
  signedIn = true,
  plan = "pro" as Member["plan"] | null,
  enterprise = false,
  transcription = "cloud" as "cloud" | "api" | "local" | null,
  postProcessing = "cloud" as "cloud" | "api" | "none" | null,
}): AppState => ({
  ...INITIAL_APP_STATE,
  isEnterprise: enterprise,
  auth: signedIn
    ? { uid: "u1", email: null, displayName: null, providers: [] }
    : null,
  memberById: plan ? { u1: { id: "u1", plan } as Member } : {},
  settings: {
    ...INITIAL_APP_STATE.settings,
    aiTranscription: {
      ...INITIAL_APP_STATE.settings.aiTranscription,
      mode: transcription,
    },
    aiPostProcessing: {
      ...INITIAL_APP_STATE.settings.aiPostProcessing,
      mode: postProcessing,
    },
  },
});

describe("selectNoteStorage", () => {
  it("uses cloud for a signed-in member in cloud modes", () => {
    expect(selectNoteStorage(stateWith({}))).toBe("cloud");
    expect(selectNoteStorage(stateWith({ plan: "free" }))).toBe("cloud");
    expect(
      selectNoteStorage(
        stateWith({ transcription: null, postProcessing: null }),
      ),
    ).toBe("cloud");
  });

  it.each([
    ["signed out", { signedIn: false }],
    ["enterprise", { enterprise: true }],
    ["no cloud member", { plan: null }],
    ["API transcription", { transcription: "api" as const }],
    ["local Whisper", { transcription: "local" as const }],
    ["API post-processing", { postProcessing: "api" as const }],
    ["no post-processing", { postProcessing: "none" as const }],
  ])("uses local when %s", (_label, overrides) => {
    expect(selectNoteStorage(stateWith(overrides))).toBe("local");
  });
});
