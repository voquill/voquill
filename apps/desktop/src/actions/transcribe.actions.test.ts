import type { Transcription, UserPreferences } from "@voquill/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import {
  FAILED_TRANSCRIPT_PLACEHOLDER,
  storeFailedTranscription,
} from "./transcribe.actions";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  createTranscription: vi.fn(),
  addWordsToCurrentUser: vi.fn(),
}));

vi.mock(import("@tauri-apps/api/core"), async (importOriginal) => ({
  ...(await importOriginal()),
  invoke: mocks.invoke,
}));
vi.mock(import("../repos"), async (importOriginal) => ({
  ...(await importOriginal()),
  getTranscriptionRepo: () =>
    ({
      createTranscription: mocks.createTranscription,
      purgeStaleAudio: async () => [],
    }) as never,
}));
vi.mock("./user.actions", () => ({
  addWordsToCurrentUser: mocks.addWordsToCurrentUser,
}));
vi.mock("./app.actions", () => ({ showErrorSnackbar: vi.fn() }));
vi.mock(
  "../utils/log.utils",
  async () =>
    (await import("../sessions/streaming-session.fakes")).logUtilsMock,
);

const AUDIO = { samples: [0.1, 0.2, 0.3], sampleRate: 16_000 };
const FAILED_RESULT = {
  rawTranscript: null,
  metadata: { transcriptionMode: "cloud" as const },
  warnings: [
    "Transcript incomplete (dropped); re-transcribed the recorded audio",
  ],
  failureReason: "Network unreachable",
};

describe("storeFailedTranscription", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockResolvedValue({ filePath: "/audio/x.wav", durationMs: 1 });
    mocks.createTranscription.mockImplementation(
      async (transcription: Transcription) => transcription,
    );
    setAppState({ ...INITIAL_APP_STATE });
  });

  it("saves the audio and a failed History entry once, without counting words", async () => {
    await expect(storeFailedTranscription(AUDIO, FAILED_RESULT)).resolves.toBe(
      "saved",
    );

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "store_transcription_audio",
      expect.objectContaining({ samples: AUDIO.samples, sampleRate: 16_000 }),
    );
    expect(mocks.createTranscription).toHaveBeenCalledTimes(1);
    const stored: Transcription = mocks.createTranscription.mock.calls[0][0];
    expect(stored.transcript).toBe(FAILED_TRANSCRIPT_PLACEHOLDER);
    expect(stored.audio).toEqual({ filePath: "/audio/x.wav", durationMs: 1 });
    expect(stored.warnings).toEqual([
      ...FAILED_RESULT.warnings,
      "Network unreachable",
    ]);
    expect(getAppState().transcriptions.transcriptionIds).toEqual([stored.id]);
    expect(mocks.addWordsToCurrentUser).not.toHaveBeenCalled();
  });

  it("does not persist anything in incognito mode", async () => {
    setAppState({
      ...INITIAL_APP_STATE,
      userPrefs: { incognitoModeEnabled: true } as UserPreferences,
    });

    await expect(storeFailedTranscription(AUDIO, FAILED_RESULT)).resolves.toBe(
      "incognito",
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.createTranscription).not.toHaveBeenCalled();
  });

  it("reports unsaved when the audio could not be written", async () => {
    mocks.invoke.mockRejectedValue(new Error("disk full"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(storeFailedTranscription(AUDIO, FAILED_RESULT)).resolves.toBe(
      "unsaved",
    );
  });
});
