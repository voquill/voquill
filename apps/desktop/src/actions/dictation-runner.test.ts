import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";
import type { BaseStrategy } from "../strategies/base.strategy";
import type { HandleTranscriptParams } from "../types/strategy.types";
import type {
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import {
  DictationRunner,
  type DictationRunnerEffects,
  type StoppedRecording,
} from "./dictation-runner";

const mocks = vi.hoisted(() => ({
  storeTranscription: vi.fn(),
  storeFailedTranscription: vi.fn(),
}));

vi.mock(import("./transcribe.actions"), async (importOriginal) => ({
  ...(await importOriginal()),
  storeTranscription: mocks.storeTranscription,
  storeFailedTranscription: mocks.storeFailedTranscription,
}));
vi.mock("./member.actions", () => ({ refreshMember: vi.fn() }));
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

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

const flush = async () => {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
};

const audioOf = (label: number): StopRecordingResponse => ({
  samples: [label],
  sampleRate: 16_000,
});

const transcript = (text: string): TranscriptionSessionResult => ({
  rawTranscript: text,
  metadata: {},
  warnings: [],
});

class FakeSession implements TranscriptionSession {
  readonly name = "Fake";
  readonly finalizeCalls: StopRecordingResponse[] = [];
  cleanup = vi.fn();
  onRecordingStart = vi.fn(async () => {});
  finalizeResult: Promise<TranscriptionSessionResult> = Promise.resolve(
    transcript("hello"),
  );

  async finalize(audio: StopRecordingResponse) {
    this.finalizeCalls.push(audio);
    return await this.finalizeResult;
  }

  supportsStreaming() {
    return false;
  }

  setInterimResultCallback() {}
}

/** Pastes whatever it is handed unless its dictation was cancelled first. */
class FakeStrategy {
  readonly pasted: string[] = [];
  shouldContinue = false;
  postProcessing: Promise<void> = Promise.resolve();
  cleanup = vi.fn(async () => {});
  setPhase = vi.fn(async () => {});
  onBeforeStart = vi.fn(async () => {});
  validateAvailability() {
    return null;
  }
  shouldStoreTranscript() {
    return true;
  }
  handleInterimSegment() {}
  async handleTranscript(args: HandleTranscriptParams) {
    await this.postProcessing;
    if (!args.signal.aborted) {
      this.pasted.push(args.rawTranscript);
    }
    return {
      shouldContinue: this.shouldContinue,
      transcript: args.rawTranscript,
      sanitizedTranscript: args.rawTranscript,
      postProcessMetadata: {},
      postProcessWarnings: [],
    };
  }
}

const setup = () => {
  const sessions: FakeSession[] = [];
  const strategies: FakeStrategy[] = [];
  const stopRecorderResults: Deferred<StoppedRecording>[] = [];
  let nextAudio = 1;
  const effects = {
    createStrategy: vi.fn(() => {
      const strategy = new FakeStrategy();
      strategies.push(strategy);
      return strategy as unknown as BaseStrategy;
    }),
    createSession: vi.fn(() => {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    }),
    beginRecording: vi.fn(),
    startRecorder: vi.fn(async () => 16_000),
    onRecordingLive: vi.fn(),
    stopRecorder: vi.fn(async (): Promise<StoppedRecording> => {
      const pending = stopRecorderResults.shift();
      if (pending) {
        return await pending.promise;
      }
      return { audio: audioOf(nextAudio++), a11yInfo: null, appTarget: null };
    }),
    resolveToneId: vi.fn(() => null),
    resetToIdle: vi.fn(),
    setStopping: vi.fn(),
    onStartFailed: vi.fn(),
  } satisfies DictationRunnerEffects;
  const runner = new DictationRunner(() => effects);
  return { runner, effects, sessions, strategies, stopRecorderResults };
};

describe("DictationRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storeFailedTranscription.mockResolvedValue("saved");
    setAppState({ ...INITIAL_APP_STATE, activeRecordingMode: "dictate" });
  });

  it("delivers and stores a dictation once, then returns to idle", async () => {
    const { runner, effects, strategies } = setup();

    await runner.start({ mode: "dictate", language: null });
    expect(effects.onRecordingLive).toHaveBeenCalledTimes(1);
    await runner.stop();

    expect(strategies[0].pasted).toEqual(["hello"]);
    expect(mocks.storeTranscription).toHaveBeenCalledTimes(1);
    expect(effects.resetToIdle).toHaveBeenCalledTimes(1);
    expect(effects.setStopping.mock.calls).toEqual([[true], [false]]);
    expect(runner.currentRun).toBeNull();
  });

  it("cancel during post-processing then restart: the cancelled text is never delivered and the new recording survives", async () => {
    const { runner, effects, sessions, strategies } = setup();
    await runner.start({ mode: "dictate", language: null });
    const postProcessing = deferred<void>();
    strategies[0].postProcessing = postProcessing.promise;

    const stopA = runner.stop();
    await flush();
    runner.cancel();
    expect(effects.setStopping).toHaveBeenLastCalledWith(false);

    await runner.start({ mode: "dictate", language: null });
    const runB = runner.currentRun;
    expect(runB?.session).toBe(sessions[1]);
    const resetsBefore = effects.resetToIdle.mock.calls.length;

    postProcessing.resolve();
    await stopA;

    expect(strategies[0].pasted).toEqual([]);
    expect(mocks.storeTranscription).not.toHaveBeenCalled();
    expect(effects.resetToIdle).toHaveBeenCalledTimes(resetsBefore);
    expect(runner.currentRun).toBe(runB);
    expect(sessions[1].cleanup).not.toHaveBeenCalled();
    expect(effects.setStopping).toHaveBeenLastCalledWith(false);
  });

  it("cancel during recovery then restart: the old flow ends without touching the new dictation", async () => {
    const { runner, effects, sessions } = setup();
    await runner.start({ mode: "dictate", language: null });
    const recovery = deferred<TranscriptionSessionResult>();
    sessions[0].finalizeResult = recovery.promise;

    const stopA = runner.stop();
    await flush();
    runner.cancel();
    expect(sessions[0].cleanup).toHaveBeenCalled();

    await runner.start({ mode: "dictate", language: null });
    const runB = runner.currentRun;
    const resetsBefore = effects.resetToIdle.mock.calls.length;

    recovery.resolve({
      rawTranscript: null,
      metadata: {},
      warnings: [],
      failureReason: "Cancelled",
    });
    await stopA;

    expect(mocks.storeFailedTranscription).not.toHaveBeenCalled();
    expect(effects.resetToIdle).toHaveBeenCalledTimes(resetsBefore);
    expect(runner.currentRun).toBe(runB);
    expect(sessions[1].cleanup).not.toHaveBeenCalled();
  });

  it("restart during the awaits before finalize never hands the new session the old audio", async () => {
    const { runner, effects, sessions, stopRecorderResults } = setup();
    await runner.start({ mode: "dictate", language: null });
    const stopped = deferred<StoppedRecording>();
    stopRecorderResults.push(stopped);

    const stopA = runner.stop();
    await flush();
    runner.cancel();
    await runner.start({ mode: "dictate", language: null });
    const resetsBefore = effects.resetToIdle.mock.calls.length;

    stopped.resolve({ audio: audioOf(1), a11yInfo: null, appTarget: null });
    await stopA;

    expect(sessions[0].finalizeCalls).toEqual([]);
    expect(sessions[1].finalizeCalls).toEqual([]);
    expect(effects.resolveToneId).not.toHaveBeenCalled();
    expect(effects.resetToIdle).toHaveBeenCalledTimes(resetsBefore);
    expect(runner.currentRun?.session).toBe(sessions[1]);
  });

  it("ignores a second stop of the same dictation", async () => {
    const { runner, effects, strategies } = setup();
    await runner.start({ mode: "dictate", language: null });

    await Promise.all([runner.stop(), runner.stop()]);

    expect(effects.stopRecorder).toHaveBeenCalledTimes(1);
    expect(strategies[0].pasted).toEqual(["hello"]);
    expect(mocks.storeTranscription).toHaveBeenCalledTimes(1);
  });

  it("stop racing an unfinished start stops the late recorder and never goes live", async () => {
    const { runner, effects, sessions } = setup();
    const recorder = deferred<number>();
    effects.startRecorder.mockReturnValueOnce(recorder.promise);
    sessions.length = 0;

    const start = runner.start({ mode: "dictate", language: null });
    await flush();
    effects.stopRecorder.mockResolvedValueOnce({
      audio: { samples: [], sampleRate: 0 },
      a11yInfo: null,
      appTarget: null,
    });
    sessions[0].finalizeResult = Promise.resolve({
      rawTranscript: null,
      metadata: {},
      warnings: [],
    });
    await runner.stop();
    expect(runner.currentRun).toBeNull();
    const resetsAfterStop = effects.resetToIdle.mock.calls.length;

    recorder.resolve(16_000);
    await start;

    expect(sessions[0].onRecordingStart).not.toHaveBeenCalled();
    expect(effects.onRecordingLive).not.toHaveBeenCalled();
    expect(effects.resetToIdle).toHaveBeenCalledTimes(resetsAfterStop + 1);
  });

  it("does not go live when stopped while the stream is still connecting", async () => {
    const { runner, effects, sessions } = setup();
    const connecting = deferred<void>();
    effects.createSession.mockImplementationOnce(() => {
      const session = new FakeSession();
      session.onRecordingStart = vi.fn(() => connecting.promise);
      sessions.push(session);
      return session;
    });

    const start = runner.start({ mode: "dictate", language: null });
    await flush();
    const stop = runner.stop();
    await flush();
    connecting.resolve();
    await Promise.all([start, stop]);

    expect(effects.onRecordingLive).not.toHaveBeenCalled();
  });

  it("keeps the agent strategy across recordings while the conversation continues", async () => {
    const { runner, effects, strategies } = setup();
    await runner.start({ mode: "agent", language: null });
    strategies[0].shouldContinue = true;
    await runner.stop();

    expect(effects.resetToIdle).not.toHaveBeenCalled();
    await runner.start({ mode: "agent", language: null });

    expect(effects.createStrategy).toHaveBeenCalledTimes(1);
    expect(runner.currentRun?.strategy).toBe(strategies[0]);
  });

  it("shows the failure notice and keeps the audio when transcription fails", async () => {
    const { runner, effects, sessions } = setup();
    await runner.start({ mode: "dictate", language: null });
    sessions[0].finalizeResult = Promise.resolve({
      rawTranscript: null,
      metadata: {},
      warnings: ["x"],
      failureReason: "offline",
    });

    await runner.stop();

    expect(mocks.storeFailedTranscription).toHaveBeenCalledTimes(1);
    expect(effects.resetToIdle).toHaveBeenCalledWith({
      body: "Couldn't transcribe your dictation. Your audio is saved in History, where you can retry it.",
    });
  });
});
