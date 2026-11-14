import type { Member } from "@voquill/types";
import { describe, expect, it } from "vitest";
import { INITIAL_APP_STATE, type AppState } from "../state/app.state";
import {
  estimateNoteWords,
  getLocalNoteProcessedWith,
  getLocalNoteTranscriptionWordBudget,
  selectNoteStorage,
} from "./note.utils";

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

  it("uses cloud before the member record has loaded (tray start at launch)", () => {
    expect(selectNoteStorage(stateWith({ plan: null }))).toBe("cloud");
    expect(
      selectNoteStorage(
        stateWith({ plan: null, transcription: null, postProcessing: null }),
      ),
    ).toBe("cloud");
  });

  it.each([
    ["signed out", { signedIn: false }],
    ["enterprise", { enterprise: true }],
    ["API transcription", { transcription: "api" as const }],
    ["local Whisper", { transcription: "local" as const }],
    ["API post-processing", { postProcessing: "api" as const }],
    ["no post-processing", { postProcessing: "none" as const }],
  ])("uses local when %s", (_label, overrides) => {
    expect(selectNoteStorage(stateWith(overrides))).toBe("local");
  });
});

describe("local note processing routes (B1)", () => {
  it("records Voquill, an API provider or this device for each part", () => {
    const state = {
      ...stateWith({ transcription: "local", postProcessing: "api" }),
      apiKeyById: {
        k: {
          id: "k",
          name: "k",
          provider: "groq",
          createdAt: "",
          keyFull: "x",
        },
      },
      settings: {
        ...stateWith({}).settings,
        aiTranscription: {
          ...INITIAL_APP_STATE.settings.aiTranscription,
          mode: "local" as const,
        },
        aiPostProcessing: { mode: "api" as const, selectedApiKeyId: "k" },
      },
    } as AppState;
    expect(getLocalNoteProcessedWith(state)).toEqual({
      transcription: { kind: "device" },
      notes: { kind: "api", provider: "groq" },
    });
  });

  it("meters only Voquill cloud transcription against the dictation words", () => {
    const member = {
      id: "u1",
      plan: "free",
      wordsToday: 100,
      wordsThisWeek: 900,
      wordsThisMonth: 900,
    } as Member;
    const config = {
      freeWordsPerDay: 2_000,
      freeWordsPerWeek: 1_000,
      freeWordsPerMonth: 10_000,
    } as AppState["config"];
    const cloud = {
      ...stateWith({ postProcessing: "api" }),
      memberById: { u1: member },
      config,
    };
    expect(getLocalNoteTranscriptionWordBudget(cloud)).toBe(100);
    expect(
      getLocalNoteTranscriptionWordBudget({
        ...cloud,
        settings: {
          ...cloud.settings,
          aiTranscription: { ...cloud.settings.aiTranscription, mode: "api" },
        },
      }),
    ).toBeNull();
    expect(estimateNoteWords(60 * 60_000)).toBe(9_000);
  });
});
