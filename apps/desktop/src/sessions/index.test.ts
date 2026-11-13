import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";
import type { TranscriptionPrefs } from "../utils/user.utils";
import { createTranscriptionSession, getTranscriptionAttemptTimeout } from ".";
import { transcribeResult } from "./streaming-session.fakes";

const mocks = vi.hoisted(() => ({
  transcribeAudio: vi.fn(),
  isEnterprise: false,
}));

vi.mock(import("../actions/transcribe.actions"), async (importOriginal) => ({
  ...(await importOriginal()),
  transcribeAudio: mocks.transcribeAudio,
}));
vi.mock(import("../utils/enterprise.utils"), async (importOriginal) => ({
  ...(await importOriginal()),
  getIsEnterpriseEnabled: () => mocks.isEnterprise,
}));
vi.mock(
  "../utils/log.utils",
  async () => (await import("./streaming-session.fakes")).logUtilsMock,
);

const apiPrefs = (provider: string): TranscriptionPrefs =>
  ({
    mode: "api",
    provider,
    apiKeyId: "key",
    apiKeyValue: "secret",
    transcriptionModel: null,
    warnings: [],
  }) as TranscriptionPrefs;

describe("getTranscriptionAttemptTimeout", () => {
  beforeEach(() => {
    mocks.isEnterprise = false;
  });

  it("does not cap local, self-hosted or New Server transcription", () => {
    expect(
      getTranscriptionAttemptTimeout({
        mode: "local",
        warnings: [],
      } as unknown as TranscriptionPrefs),
    ).toBeNull();
    expect(getTranscriptionAttemptTimeout(apiPrefs("speaches"))).toBeNull();
    expect(
      getTranscriptionAttemptTimeout(apiPrefs("openai-compatible")),
    ).toBeNull();
    expect(
      getTranscriptionAttemptTimeout({ mode: "cloud", warnings: [] }),
    ).toBeNull();
  });

  it("caps hosted providers generously relative to the audio length", () => {
    const timeout = getTranscriptionAttemptTimeout(apiPrefs("groq"));
    expect(timeout?.(60_000)).toBe(180_000);

    mocks.isEnterprise = true;
    expect(
      getTranscriptionAttemptTimeout({ mode: "cloud", warnings: [] }),
    ).not.toBeNull();
  });
});

describe("createTranscriptionSession", () => {
  beforeEach(() => {
    mocks.transcribeAudio.mockReset();
    mocks.transcribeAudio.mockResolvedValue(transcribeResult("text"));
    setAppState({ ...INITIAL_APP_STATE });
  });

  it("transcribes with the preferences the dictation started with", async () => {
    const prefs = apiPrefs("groq");
    const session = createTranscriptionSession(prefs);

    await session.finalize({ samples: [0.1, 0.2], sampleRate: 16_000 });

    expect(mocks.transcribeAudio).toHaveBeenCalledWith(
      expect.objectContaining({ transcriptionPrefs: prefs }),
    );
  });
});
