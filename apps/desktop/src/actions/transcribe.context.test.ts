import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppState, INITIAL_APP_STATE } from "../state/app.state";
import * as transcribeActions from "./transcribe.actions";

const { storeState, generateTextMock, invokeMock } = vi.hoisted(() => ({
  storeState: {
    appState: undefined as AppState | undefined,
  },
  generateTextMock: vi.fn(),
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return {
    ...actual,
    invoke: invokeMock,
  };
});

vi.mock("../repos", () => ({
  getGenerateTextRepo: () => ({
    repo: {
      generateText: generateTextMock,
    },
    apiKeyId: "post-process-key",
    warnings: [],
  }),
  getTranscribeAudioRepo: () => ({
    repo: {
      transcribeAudio: vi.fn(),
    },
    apiKeyId: "transcribe-key",
    warnings: [],
  }),
  getTranscriptionRepo: () => ({
    createTranscription: vi.fn(),
    purgeStaleAudio: vi.fn(),
  }),
}));

vi.mock("../store", () => ({
  getAppState: () => storeState.appState,
  produceAppState: vi.fn(),
}));

vi.mock("./app.actions", () => ({
  showErrorSnackbar: vi.fn(),
}));

vi.mock("./user.actions", () => ({
  addWordsToCurrentUser: vi.fn(),
}));

vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    verbose: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }),
}));

describe("desktop dictation context", () => {
  beforeEach(() => {
    storeState.appState = structuredClone(INITIAL_APP_STATE);
    storeState.appState!.toneById = {
      default: {
        id: "default",
        name: "Default",
        promptTemplate: "Clean up the provided transcript",
        isSystem: true,
        createdAt: 0,
        sortOrder: 0,
      },
    };
    generateTextMock.mockReset();
    invokeMock.mockReset();
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({ result: "Clean transcript" }),
      metadata: {
        postProcessingMode: "cloud",
        inferenceDevice: "Cloud • Test",
      },
    });
  });

  it("derives current editor and selected text from finalize-time accessibility info", () => {
    expect("resolveDesktopDictationContext" in transcribeActions).toBe(true);

    const context = (
      transcribeActions as Record<string, any>
    ).resolveDesktopDictationContext({
      currentApp: {
        id: "notion",
        name: "Notion",
      },
      a11yInfo: {
        cursorPosition: 6,
        selectionLength: 6,
        textContent: "Draft launch plan",
      },
      screenContext: "Release checklist",
    });

    expect(context).toEqual({
      currentApp: {
        id: "notion",
        name: "Notion",
      },
      currentEditor: {
        id: "focused-text-field",
        name: "Focused text field",
      },
      selectedText: "launch",
      screenContext: "Release checklist",
    });
  });

  it("normalizes screen capture context command failures to null", async () => {
    invokeMock.mockRejectedValueOnce(new Error("screen capture unavailable"));

    const { getScreenCaptureContext } =
      await import("../utils/screen-context-provider");

    await expect(getScreenCaptureContext()).resolves.toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("get_screen_capture_context");
  });

  it("passes through screen capture context OCR text when the command succeeds", async () => {
    invokeMock.mockResolvedValueOnce("Draft launch checklist");

    const { getScreenCaptureContext } =
      await import("../utils/screen-context-provider");

    await expect(getScreenCaptureContext()).resolves.toBe(
      "Draft launch checklist",
    );
    expect(invokeMock).toHaveBeenCalledWith("get_screen_capture_context");
  });

  it("includes finalize-time app, editor, selection, and screen context in post-processing prompts", async () => {
    await transcribeActions.postProcessTranscript({
      rawTranscript: "update the summary",
      toneId: null,
      currentApp: {
        id: "notion",
        name: "Notion",
      },
      currentEditor: {
        id: "focused-text-field",
        name: "Focused text field",
      },
      selectedText: "launch",
      screenContext: "Release checklist",
    } as any);

    expect(generateTextMock).toHaveBeenCalledTimes(1);

    const [call] = generateTextMock.mock.calls;
    expect(call[0].system).toContain("<ACTIVE_APP>");
    expect(call[0].system).toContain("Notion");
    expect(call[0].system).toContain("Focused text field");
    expect(call[0].system).toContain("<CURRENTLY_SELECTED_TEXT>");
    expect(call[0].system).toContain("launch");
    expect(call[0].system).toContain("<CURRENT_WINDOW_CONTEXT>");
    expect(call[0].system).toContain("Release checklist");
  });
});
