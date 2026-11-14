import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";
import type { HandleTranscriptParams } from "../types/strategy.types";
import { DictationStrategy } from "./dictation.strategy";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  routeTranscriptOutput: vi.fn(),
  postProcessTranscript: vi.fn(),
  showToast: vi.fn(),
  realtimeOutputEnabled: false,
  remoteTargetDeviceId: null as string | null,
}));

vi.mock(import("@tauri-apps/api/core"), async (importOriginal) => ({
  ...(await importOriginal()),
  invoke: mocks.invoke,
}));
vi.mock("../utils/output-routing.utils", () => ({
  routeTranscriptOutput: mocks.routeTranscriptOutput,
}));
vi.mock(import("../actions/transcribe.actions"), async (importOriginal) => ({
  ...(await importOriginal()),
  postProcessTranscript: mocks.postProcessTranscript,
}));
vi.mock("../actions/toast.actions", () => ({ showToast: mocks.showToast }));
vi.mock("../actions/app.actions", () => ({
  showSnackbar: vi.fn(),
  showErrorSnackbar: vi.fn(),
}));
vi.mock("../i18n", () => ({
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
vi.mock(import("../utils/tone.utils"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getToneIdToUse: () => actual.VERBATIM_TONE_ID };
});
vi.mock(import("../utils/user.utils"), async (importOriginal) => ({
  ...(await importOriginal()),
  getMyUserPreferences: () =>
    ({
      realtimeOutputEnabled: mocks.realtimeOutputEnabled,
      remoteOutputEnabled: !!mocks.remoteTargetDeviceId,
      remoteTargetDeviceId: mocks.remoteTargetDeviceId,
    }) as never,
}));

const params = (
  overrides: Partial<HandleTranscriptParams> = {},
): HandleTranscriptParams => ({
  rawTranscript: "hello there world",
  toneId: null,
  a11yInfo: null,
  currentApp: null,
  loadingToken: null,
  audio: { samples: [0.1], sampleRate: 16_000 },
  transcriptionMetadata: {},
  transcriptionWarnings: [],
  transcriptionRecovered: false,
  signal: new AbortController().signal,
  ...overrides,
});

const routedTexts = () =>
  mocks.routeTranscriptOutput.mock.calls.map(([args]) => args.text);

describe("DictationStrategy.handleTranscript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.realtimeOutputEnabled = false;
    mocks.remoteTargetDeviceId = null;
    mocks.invoke.mockResolvedValue(undefined);
    mocks.routeTranscriptOutput.mockResolvedValue({
      delivered: true,
      remote: false,
    });
    mocks.postProcessTranscript.mockResolvedValue({
      transcript: "Hello there, world.",
      warnings: [],
      metadata: { postProcessMode: "cloud" },
    });
    setAppState({ ...INITIAL_APP_STATE });
  });

  it("post-processes and pastes a recovered transcript exactly once", async () => {
    const strategy = new DictationStrategy();

    const result = await strategy.handleTranscript(
      params({ transcriptionRecovered: true }),
    );

    expect(mocks.postProcessTranscript).toHaveBeenCalledTimes(1);
    expect(routedTexts()).toEqual(["Hello there, world. "]);
    expect(result.transcript).toBe("Hello there, world.");
  });

  it("pastes the unprocessed transcript when post-processing fails", async () => {
    mocks.postProcessTranscript.mockRejectedValue(new Error("LLM offline"));
    const strategy = new DictationStrategy();

    const result = await strategy.handleTranscript(params());

    expect(routedTexts()).toEqual(["hello there world "]);
    expect(result.transcript).toBe("hello there world");
    expect(result.postProcessWarnings).toEqual([
      "Post-processing failed, used unprocessed transcript: LLM offline",
    ]);
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it("does not paste the final transcript again after live segments were pasted", async () => {
    mocks.realtimeOutputEnabled = true;
    const strategy = new DictationStrategy();
    strategy.handleInterimSegment("hello there");
    strategy.handleInterimSegment("world");

    const result = await strategy.handleTranscript(params());

    expect(routedTexts()).toEqual(["hello there ", "world "]);
    expect(result.transcript).toBe("hello there world");
  });

  it("copies a recovered transcript to the clipboard instead of re-pasting over live segments", async () => {
    mocks.realtimeOutputEnabled = true;
    const strategy = new DictationStrategy();
    strategy.handleInterimSegment("hello there");

    const result = await strategy.handleTranscript(
      params({ transcriptionRecovered: true }),
    );

    expect(routedTexts()).toEqual(["hello there "]);
    expect(mocks.postProcessTranscript).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("copy_to_clipboard", {
      text: "hello there world",
    });
    expect(mocks.showToast).toHaveBeenCalledTimes(1);
    expect(result.transcript).toBe("hello there world");
  });

  it("sends a recovered transcript to the paired device when remote output is on", async () => {
    mocks.realtimeOutputEnabled = true;
    mocks.remoteTargetDeviceId = "laptop";
    mocks.routeTranscriptOutput.mockResolvedValue({
      delivered: true,
      remote: true,
    });
    const strategy = new DictationStrategy();
    strategy.handleInterimSegment("hello there");

    const result = await strategy.handleTranscript(
      params({ transcriptionRecovered: true }),
    );

    expect(routedTexts()).toEqual(["hello there ", "hello there world "]);
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "copy_to_clipboard",
      expect.anything(),
    );
    expect(result).toMatchObject({
      transcript: "hello there world",
      remoteStatus: "sent",
      remoteDeviceId: "laptop",
    });
  });

  it("does not paste or post-process output of a cancelled dictation", async () => {
    const controller = new AbortController();
    let finishPostProcess: (value: unknown) => void = () => {};
    mocks.postProcessTranscript.mockReturnValue(
      new Promise((resolve) => (finishPostProcess = resolve)),
    );
    const strategy = new DictationStrategy();

    const pending = strategy.handleTranscript(
      params({ signal: controller.signal }),
    );
    controller.abort();
    finishPostProcess({
      transcript: "Hello there, world.",
      warnings: [],
      metadata: {},
    });
    await pending;

    expect(mocks.routeTranscriptOutput).not.toHaveBeenCalled();
  });

  it("does not deliver a recovered transcript after the dictation was cancelled", async () => {
    mocks.realtimeOutputEnabled = true;
    const controller = new AbortController();
    const strategy = new DictationStrategy();
    strategy.handleInterimSegment("hello there");
    controller.abort();

    await strategy.handleTranscript(
      params({ transcriptionRecovered: true, signal: controller.signal }),
    );

    expect(routedTexts()).toEqual(["hello there "]);
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "copy_to_clipboard",
      expect.anything(),
    );
  });
});
