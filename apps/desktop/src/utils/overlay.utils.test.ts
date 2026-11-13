import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import {
  dismissPillToast,
  holdPillVisibleForFlash,
  PILL_FIREWORKS_DURATION_MS,
  PILL_FLASH_DEFAULT_DURATION_MS,
  PILL_FLASH_EXIT_ANIMATION_MS,
  sendPillFireworks,
  sendPillFlashMessage,
  sendPillToast,
} from "./overlay.utils";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock(import("@tauri-apps/api/core"), async (importOriginal) => ({
  ...(await importOriginal()),
  invoke: invokeMock,
}));

const isHeld = () => getAppState().isPillFlashShowing;

const lastPillPayload = () =>
  JSON.parse(invokeMock.mock.calls.at(-1)![1].payload as string);

describe("pill flash visibility hold", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    setAppState({ ...INITIAL_APP_STATE });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("holds the pill visible through the flash display and exit animation", () => {
    sendPillFlashMessage("Transcript copied to clipboard");
    expect(isHeld()).toBe(true);

    vi.advanceTimersByTime(
      PILL_FLASH_DEFAULT_DURATION_MS + PILL_FLASH_EXIT_ANIMATION_MS - 1,
    );
    expect(isHeld()).toBe(true);

    vi.advanceTimersByTime(1);
    expect(isHeld()).toBe(false);
  });

  it("sends the display duration it holds for to the native pill", async () => {
    await sendPillToast({
      message: "Recording will stop in 60 seconds",
      toastType: "info",
      durationMs: 5_000,
      action: null,
      actionLabel: null,
    });

    expect(lastPillPayload()).toMatchObject({ type: "toast", duration: 5 });
    vi.advanceTimersByTime(5_000 + PILL_FLASH_EXIT_ANIMATION_MS - 1);
    expect(isHeld()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isHeld()).toBe(false);
  });

  it("does not cut a longer flash short when a shorter one follows", () => {
    sendPillFireworks("Congratulations!");
    vi.advanceTimersByTime(1_000);
    sendPillFlashMessage("Transcript copied to clipboard");

    vi.advanceTimersByTime(
      PILL_FIREWORKS_DURATION_MS - 1_000 + PILL_FLASH_EXIT_ANIMATION_MS - 1,
    );
    expect(isHeld()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isHeld()).toBe(false);
  });

  it("extends the hold when a later flash outlasts the current one", () => {
    holdPillVisibleForFlash(1_000);
    vi.advanceTimersByTime(500);
    holdPillVisibleForFlash(3_000);

    vi.advanceTimersByTime(3_000 + PILL_FLASH_EXIT_ANIMATION_MS - 1);
    expect(isHeld()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isHeld()).toBe(false);
  });

  it("releases the hold after the exit animation when a toast is dismissed", async () => {
    sendPillFlashMessage("Press cancel again to discard transcript");
    vi.advanceTimersByTime(500);
    await dismissPillToast();

    vi.advanceTimersByTime(PILL_FLASH_EXIT_ANIMATION_MS - 1);
    expect(isHeld()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isHeld()).toBe(false);
  });
});
