import { INITIAL_APP_STATE } from "../../src/state/app.state";
import { afterEach, expect, test, vi } from "vitest";

const { routeTranscriptOutput, postProcessTranscript } = vi.hoisted(() => ({
  routeTranscriptOutput: vi.fn().mockResolvedValue({
    delivered: false,
    remote: false,
  }),
  postProcessTranscript: vi.fn().mockResolvedValue({
    transcript: "Polished launch summary",
    warnings: [],
    metadata: {},
  }),
}));

vi.mock("../../src/utils/output-routing.utils", () => ({
  routeTranscriptOutput,
}));

vi.mock("../../src/actions/transcribe.actions", () => ({
  postProcessTranscript,
}));

vi.mock("../../src/utils/log.utils", () => ({
  getLogger: () => ({
    verbose: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../../src/store", () => {
  let state: Record<string, unknown> = {};

  return {
    getAppState: () => state,
    setAppState: (nextState: Record<string, unknown>) => {
      state = nextState;
    },
  };
});

vi.mock("../../src/utils/tone.utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/utils/tone.utils")>();
  return {
    ...actual,
    getToneIdToUse: () => actual.VERBATIM_TONE_ID,
  };
});

const { setAppState } = await import("../../src/store");
const { DictationStrategy } =
  await import("../../src/strategies/dictation.strategy");

afterEach(() => {
  routeTranscriptOutput.mockClear();
  postProcessTranscript.mockClear();
  setAppState({ ...INITIAL_APP_STATE });
});

test("streamed dictation inserts live deltas and only appends the final tail", async () => {
  setAppState({
    ...INITIAL_APP_STATE,
    userPrefs: {
      realtimeOutputEnabled: true,
      remoteOutputEnabled: false,
      remoteTargetDeviceId: null,
    } as never,
  });

  const strategy = new DictationStrategy();

  strategy.handleInterimSegment("hello");
  await Promise.resolve();
  await Promise.resolve();

  expect(routeTranscriptOutput).toHaveBeenCalledTimes(1);
  expect(routeTranscriptOutput).toHaveBeenNthCalledWith(1, {
    text: "hello ",
    mode: "dictation",
    currentAppId: null,
  });

  const result = await strategy.handleTranscript({
    rawTranscript: "hello world",
    processedTranscript: null,
    toneId: null,
    a11yInfo: null,
    currentApp: null,
    loadingToken: null,
    audio: { samples: [], sampleRate: 16000 },
    transcriptionMetadata: {},
    transcriptionWarnings: [],
  });

  expect(routeTranscriptOutput).toHaveBeenCalledTimes(2);
  expect(routeTranscriptOutput).toHaveBeenNthCalledWith(2, {
    text: "world ",
    mode: "dictation",
    currentAppId: null,
  });
  expect(result.transcript).toBe("hello world");
  expect(result.sanitizedTranscript).toBe("hello world");
});

test("bulk dictation forwards merged screen context into post-processing", async () => {
  setAppState({
    ...INITIAL_APP_STATE,
    userPrefs: {
      realtimeOutputEnabled: false,
      remoteOutputEnabled: false,
      remoteTargetDeviceId: null,
    } as never,
  });

  const strategy = new DictationStrategy();
  const mergedScreenContext =
    "Accessibility context: Release dashboard Screen capture OCR: Draft launch checklist";

  const result = await strategy.handleTranscript({
    rawTranscript: "update the summary",
    processedTranscript: null,
    toneId: "professional",
    a11yInfo: null,
    currentApp: {
      id: "notion",
      name: "Notion",
    } as never,
    currentEditor: {
      id: "focused-text-field",
      name: "Focused text field",
    },
    selectedText: "launch summary",
    screenContext: mergedScreenContext,
    loadingToken: null,
    audio: { samples: [], sampleRate: 16000 },
    transcriptionMetadata: {},
    transcriptionWarnings: [],
  });

  expect(postProcessTranscript).toHaveBeenCalledWith(
    expect.objectContaining({
      currentApp: {
        id: "notion",
        name: "Notion",
      },
      currentEditor: {
        id: "focused-text-field",
        name: "Focused text field",
      },
      selectedText: "launch summary",
      screenContext: mergedScreenContext,
    }),
  );
  expect(routeTranscriptOutput).toHaveBeenCalledWith({
    text: "Polished launch summary ",
    mode: "dictation",
    currentAppId: "notion",
  });
  expect(result.transcript).toBe("Polished launch summary");
});
