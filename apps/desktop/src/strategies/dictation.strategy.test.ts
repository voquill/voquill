import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE, type AppState } from "../state/app.state";
import { DictationStrategy } from "./dictation.strategy";

const { storeState, routeTranscriptOutputMock, getToneIdToUseMock } =
  vi.hoisted(() => ({
    storeState: {
      appState: undefined as AppState | undefined,
    },
    routeTranscriptOutputMock: vi.fn(),
    getToneIdToUseMock: vi.fn(),
  }));

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();

  return {
    ...actual,
    invoke: vi.fn(),
  };
});

vi.mock("../store", () => ({
  getAppState: () => storeState.appState,
}));

vi.mock("../actions/app.actions", () => ({
  showErrorSnackbar: vi.fn(),
  showSnackbar: vi.fn(),
}));

vi.mock("../actions/app-target.actions", () => ({
  tryRegisterCurrentAppTarget: vi.fn(),
}));

vi.mock("../actions/toast.actions", () => ({
  showToast: vi.fn(),
}));

vi.mock("../actions/transcribe.actions", () => ({
  postProcessTranscript: vi.fn(),
}));

vi.mock("../i18n", () => ({
  getIntl: () => ({
    formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
  }),
}));

vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    verbose: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../utils/member.utils", () => ({
  getMemberExceedsLimitByState: vi.fn(() => false),
}));

vi.mock("../utils/output-routing.utils", () => ({
  routeTranscriptOutput: routeTranscriptOutputMock,
}));

vi.mock("../utils/tone.utils", () => ({
  VERBATIM_TONE_ID: "verbatim",
  getToneIdToUse: getToneIdToUseMock,
}));

vi.mock("../utils/user.utils", () => ({
  getEffectivePostProcessingMode: vi.fn(() => "none"),
  getEffectiveTranscriptionMode: vi.fn(() => "local"),
  getMyUserPreferences: (state: AppState) => state.userPrefs,
}));

describe("DictationStrategy", () => {
  beforeEach(() => {
    storeState.appState = structuredClone(INITIAL_APP_STATE);
    storeState.appState.userPrefs = {
      realtimeOutputEnabled: true,
      remoteOutputEnabled: false,
      remoteTargetDeviceId: null,
    } as AppState["userPrefs"];

    routeTranscriptOutputMock.mockReset();
    routeTranscriptOutputMock.mockResolvedValue({
      delivered: true,
      remote: false,
    });

    getToneIdToUseMock.mockReset();
    getToneIdToUseMock.mockReturnValue("verbatim");
  });

  it("routes streamed verbatim text live and only inserts the final tail on finalize", async () => {
    const strategy = new DictationStrategy();

    strategy.handleInterimSegment("hello");

    await Promise.resolve();
    await Promise.resolve();

    expect(routeTranscriptOutputMock).toHaveBeenCalledTimes(1);
    expect(routeTranscriptOutputMock).toHaveBeenNthCalledWith(1, {
      text: "hello ",
      mode: "dictation",
      currentAppId: null,
    });

    const result = await strategy.handleTranscript({
      rawTranscript: "hello world",
      toneId: "verbatim",
      a11yInfo: null,
      currentApp: null,
      loadingToken: null,
      audio: {
        filePath: "",
        sampleRate: 16_000,
        sampleCount: 0,
      },
      transcriptionMetadata: {},
      transcriptionWarnings: [],
    });

    expect(routeTranscriptOutputMock).toHaveBeenCalledTimes(2);
    expect(routeTranscriptOutputMock).toHaveBeenNthCalledWith(2, {
      text: "world ",
      mode: "dictation",
      currentAppId: null,
    });
    expect(result.transcript).toBe("hello world");
  });

  it("falls back to the full final transcript after a live interim insert fails", async () => {
    const strategy = new DictationStrategy();

    routeTranscriptOutputMock
      .mockRejectedValueOnce(new Error("paste failed"))
      .mockResolvedValue({
        delivered: true,
        remote: false,
      });

    strategy.handleInterimSegment("hello");
    strategy.handleInterimSegment("world");

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(routeTranscriptOutputMock).toHaveBeenCalledTimes(1);
    expect(routeTranscriptOutputMock).toHaveBeenNthCalledWith(1, {
      text: "hello ",
      mode: "dictation",
      currentAppId: null,
    });

    const result = await strategy.handleTranscript({
      rawTranscript: "hello world",
      toneId: "verbatim",
      a11yInfo: null,
      currentApp: null,
      loadingToken: null,
      audio: {
        filePath: "",
        sampleRate: 16_000,
        sampleCount: 0,
      },
      transcriptionMetadata: {},
      transcriptionWarnings: [],
    });

    expect(routeTranscriptOutputMock).toHaveBeenCalledTimes(2);
    expect(routeTranscriptOutputMock).toHaveBeenNthCalledWith(2, {
      text: "hello world ",
      mode: "dictation",
      currentAppId: null,
    });
    expect(result.transcript).toBe("hello world");
  });
});
