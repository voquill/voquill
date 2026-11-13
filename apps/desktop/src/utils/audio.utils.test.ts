import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";
import { tryPlayAudioChime } from "./audio.utils";

const invoke = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  invoke,
}));

describe("tryPlayAudioChime", () => {
  beforeEach(() => {
    invoke.mockClear();
    setAppState(structuredClone(INITIAL_APP_STATE));
  });

  it("plays the dictation chime normally", () => {
    tryPlayAudioChime("start_recording_clip");
    expect(invoke).toHaveBeenCalledWith("play_audio", {
      clip: "start_recording_clip",
    });
  });

  it("stays silent while a meeting is being recorded, so the chime is not captured", () => {
    setAppState((state) => ({
      ...state,
      notes: {
        ...state.notes,
        capture: {
          noteId: "n",
          segmentId: "s",
          audioPath: "/a.wav",
          durationMs: 1_000,
          initialDurationMs: 0,
          level: 0,
          interruption: null,
          silent: false,
        },
      },
    }));
    tryPlayAudioChime("start_recording_clip");
    expect(invoke).not.toHaveBeenCalled();
  });
});
