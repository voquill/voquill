import type { Transcription, UserPreferences } from "@voquill/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import {
  FAILED_TRANSCRIPT_PLACEHOLDER,
  MAX_KEPT_FAILED_AUDIO_ENTRIES,
  selectFailedAudioToKeep,
  storeFailedTranscription,
} from "./transcribe.actions";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  createTranscription: vi.fn(),
  addWordsToCurrentUser: vi.fn(),
  listAudioEntries: vi.fn(),
  purgeStaleAudio: vi.fn(),
  showToast: vi.fn(),
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
      listAudioEntries: mocks.listAudioEntries,
      purgeStaleAudio: mocks.purgeStaleAudio,
    }) as never,
}));
vi.mock("./user.actions", () => ({
  addWordsToCurrentUser: mocks.addWordsToCurrentUser,
}));
vi.mock("./app.actions", () => ({ showErrorSnackbar: vi.fn() }));
vi.mock("./toast.actions", () => ({ showToast: mocks.showToast }));
vi.mock("../i18n/intl", () => ({
  getIntl: () => ({
    formatMessage: (descriptor: { defaultMessage: string }) =>
      descriptor.defaultMessage,
  }),
}));
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
    mocks.listAudioEntries.mockResolvedValue([]);
    mocks.purgeStaleAudio.mockResolvedValue([]);
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

const entry = (id: string, failed: boolean, durationMs = 10_000) => ({
  id,
  transcript: failed ? FAILED_TRANSCRIPT_PLACEHOLDER : "Hello.",
  durationMs,
});

describe("selectFailedAudioToKeep", () => {
  it("keeps every failed dictation's audio within the bounds", () => {
    expect(
      selectFailedAudioToKeep([
        entry("a", true),
        entry("b", false),
        entry("c", true),
      ]),
    ).toEqual({ keepIds: ["a", "c"], unprotectedIds: [] });
  });

  it("stops protecting the oldest failed audio past an hour in total", () => {
    const result = selectFailedAudioToKeep([
      entry("new", true, 40 * 60_000),
      entry("mid", true, 20 * 60_000),
      entry("old", true, 1_000),
    ]);
    expect(result).toEqual({
      keepIds: ["new", "mid"],
      unprotectedIds: ["old"],
    });
  });

  it("stops protecting failed audio past the entry count", () => {
    const entries = Array.from(
      { length: MAX_KEPT_FAILED_AUDIO_ENTRIES + 1 },
      (_, i) => entry(`f${i}`, true, 1_000),
    );
    const result = selectFailedAudioToKeep(entries);
    expect(result.keepIds).toHaveLength(MAX_KEPT_FAILED_AUDIO_ENTRIES);
    expect(result.unprotectedIds).toEqual([
      `f${MAX_KEPT_FAILED_AUDIO_ENTRIES}`,
    ]);
  });
});

describe("failed dictation audio retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockResolvedValue({ filePath: "/audio/x.wav", durationMs: 1 });
    mocks.createTranscription.mockImplementation(
      async (transcription: Transcription) => transcription,
    );
    setAppState({ ...INITIAL_APP_STATE });
  });

  it("exempts failed entries from the purge of older audio", async () => {
    mocks.listAudioEntries.mockResolvedValue([
      entry("new-failed", true),
      ...Array.from({ length: 25 }, (_, i) => entry(`ok${i}`, false)),
      entry("old-failed", true),
    ]);
    mocks.purgeStaleAudio.mockResolvedValue(["ok20", "ok21"]);

    await storeFailedTranscription(AUDIO, FAILED_RESULT);

    expect(mocks.purgeStaleAudio).toHaveBeenCalledWith([
      "new-failed",
      "old-failed",
    ]);
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it("tells the user when failed audio had to be removed over the bound", async () => {
    mocks.listAudioEntries.mockResolvedValue([
      entry("new", true, 60 * 60_000),
      entry("old", true, 1_000),
    ]);
    mocks.purgeStaleAudio.mockResolvedValue(["old"]);

    await storeFailedTranscription(AUDIO, FAILED_RESULT);

    expect(mocks.purgeStaleAudio).toHaveBeenCalledWith(["new"]);
    expect(mocks.showToast).toHaveBeenCalledTimes(1);
    expect(mocks.showToast.mock.calls[0][0].message).toContain(
      "Too many failed dictations",
    );
  });
});
