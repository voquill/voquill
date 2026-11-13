import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";
import type { BaseStrategy } from "../strategies/base.strategy";
import type {
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import { finishDictation } from "./dictation.actions";

const mocks = vi.hoisted(() => ({
  storeTranscription: vi.fn(),
  storeFailedTranscription: vi.fn(),
  refreshMember: vi.fn(),
}));

vi.mock(import("./transcribe.actions"), async (importOriginal) => ({
  ...(await importOriginal()),
  storeTranscription: mocks.storeTranscription,
  storeFailedTranscription: mocks.storeFailedTranscription,
}));
vi.mock("./member.actions", () => ({ refreshMember: mocks.refreshMember }));
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

const AUDIO = { samples: [0.1, 0.2], sampleRate: 16_000 };

const makeSession = (
  finalize: () => Promise<TranscriptionSessionResult>,
): TranscriptionSession => ({
  name: "Fake",
  onRecordingStart: async () => {},
  finalize: vi.fn(finalize),
  cleanup: vi.fn(),
  supportsStreaming: () => true,
  setInterimResultCallback: () => {},
});

const makeStrategy = (shouldStore = true) =>
  ({
    shouldStoreTranscript: () => shouldStore,
    setPhase: vi.fn(async () => {}),
    handleTranscript: vi.fn(async () => ({
      shouldContinue: false,
      transcript: "Hello.",
      sanitizedTranscript: "hello",
      postProcessMetadata: {},
      postProcessWarnings: [],
      remoteStatus: null,
      remoteDeviceId: null,
    })),
  }) as unknown as BaseStrategy & {
    handleTranscript: ReturnType<typeof vi.fn>;
  };

const failed: TranscriptionSessionResult = {
  rawTranscript: null,
  metadata: {},
  warnings: [
    "Transcript incomplete (dropped); re-transcribed the recorded audio",
  ],
  failureReason: "Network unreachable",
};

const run = (
  session: TranscriptionSession,
  strategy: BaseStrategy,
  isCurrent = () => true,
) =>
  finishDictation({
    session,
    strategy,
    audio: AUDIO,
    toneId: null,
    a11yInfo: null,
    appTarget: null,
    isCurrent,
  });

describe("finishDictation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storeFailedTranscription.mockResolvedValue("saved");
    setAppState({ ...INITIAL_APP_STATE, activeRecordingMode: "dictate" });
  });

  it("delivers and stores a recovered transcript exactly once", async () => {
    const session = makeSession(async () => ({
      rawTranscript: "hello",
      metadata: {},
      warnings: [
        "Transcript incomplete (x); re-transcribed the recorded audio",
      ],
      recovered: true,
    }));
    const strategy = makeStrategy();

    await expect(run(session, strategy)).resolves.toEqual({
      shouldContinue: false,
    });

    expect(strategy.handleTranscript).toHaveBeenCalledTimes(1);
    expect(strategy.handleTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ transcriptionRecovered: true }),
    );
    expect(mocks.storeTranscription).toHaveBeenCalledTimes(1);
    expect(mocks.storeFailedTranscription).not.toHaveBeenCalled();
    expect(mocks.refreshMember).toHaveBeenCalledTimes(1);
  });

  it("saves an untranscribable dictation to History and tells the user", async () => {
    const strategy = makeStrategy();

    const outcome = await run(
      makeSession(async () => failed),
      strategy,
    );

    expect(mocks.storeFailedTranscription).toHaveBeenCalledWith(AUDIO, failed);
    expect(mocks.storeTranscription).not.toHaveBeenCalled();
    expect(strategy.handleTranscript).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      shouldContinue: false,
      abortMessage:
        "Couldn't transcribe your dictation. Your audio is saved in History, where you can retry it.",
    });
  });

  it("says plainly that nothing was saved in incognito mode", async () => {
    mocks.storeFailedTranscription.mockResolvedValue("incognito");

    const outcome = await run(
      makeSession(async () => failed),
      makeStrategy(),
    );

    expect(outcome.abortMessage).toBe(
      "Couldn't transcribe your dictation. It was not saved because incognito mode is on.",
    );
  });

  it("does not store a failed agent-mode recording in History", async () => {
    setAppState({ ...INITIAL_APP_STATE, activeRecordingMode: "agent" });

    const outcome = await run(
      makeSession(async () => failed),
      makeStrategy(false),
    );

    expect(mocks.storeFailedTranscription).not.toHaveBeenCalled();
    expect(outcome.abortMessage).toBe("Couldn't transcribe your recording.");
  });

  it("discards the result and stores nothing when cancelled during recovery", async () => {
    let current = true;
    const session = makeSession(async () => {
      current = false;
      return { ...failed, failureReason: "Cancelled" };
    });
    const strategy = makeStrategy();

    const outcome = await run(session, strategy, () => current);

    expect(outcome).toEqual({ shouldContinue: false, superseded: true });
    expect(mocks.storeFailedTranscription).not.toHaveBeenCalled();
    expect(mocks.storeTranscription).not.toHaveBeenCalled();
    expect(strategy.handleTranscript).not.toHaveBeenCalled();
  });

  it("treats silence as nothing to deliver, not a failure", async () => {
    const outcome = await run(
      makeSession(async () => ({
        rawTranscript: null,
        metadata: {},
        warnings: [],
      })),
      makeStrategy(),
    );

    expect(outcome).toEqual({ shouldContinue: false });
    expect(mocks.storeFailedTranscription).not.toHaveBeenCalled();
  });
});
