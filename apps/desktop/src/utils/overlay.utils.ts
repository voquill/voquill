import { invoke } from "@tauri-apps/api/core";
import { produceAppState } from "../store";
import type { ToastType } from "../types/toast.types";

// Display durations of the native pill flash banner. Fireworks and flame have
// no duration field in the IPC contract, so these mirror the native
// FIREWORKS_TOTAL_DURATION / FLAME_TOTAL_DURATION constants.
export const PILL_FLASH_DEFAULT_DURATION_MS = 2_500;
export const PILL_FIREWORKS_DURATION_MS = 7_000;
export const PILL_FLAME_DURATION_MS = 5_000;
// The banner's critically damped spring (stiffness 200) settles in ~0.6s.
export const PILL_FLASH_EXIT_ANIMATION_MS = 750;

let pillFlashHoldUntil = 0;
let pillFlashHoldTimer: ReturnType<typeof setTimeout> | null = null;

const setPillFlashHoldUntil = (until: number): void => {
  pillFlashHoldUntil = until;
  if (pillFlashHoldTimer) {
    clearTimeout(pillFlashHoldTimer);
  }

  produceAppState((draft) => {
    draft.isPillFlashShowing = true;
  });

  pillFlashHoldTimer = setTimeout(
    () => {
      pillFlashHoldTimer = null;
      pillFlashHoldUntil = 0;
      produceAppState((draft) => {
        draft.isPillFlashShowing = false;
      });
    },
    Math.max(0, until - Date.now()),
  );
};

/**
 * Keeps the pill window visible regardless of the visibility setting until a
 * flash message shown now for `displayMs` has finished its exit animation.
 */
export const holdPillVisibleForFlash = (displayMs: number): void => {
  const until = Date.now() + displayMs + PILL_FLASH_EXIT_ANIMATION_MS;
  setPillFlashHoldUntil(Math.max(until, pillFlashHoldUntil));
};

export const releasePillFlashHold = (): void => {
  setPillFlashHoldUntil(Date.now() + PILL_FLASH_EXIT_ANIMATION_MS);
};

export type PillToast = {
  message: string;
  toastType: ToastType;
  durationMs: number;
  action: string | null;
  actionLabel: string | null;
};

export const sendPillToast = async (toast: PillToast): Promise<void> => {
  holdPillVisibleForFlash(toast.durationMs);
  await invoke("sync_native_pill_assistant", {
    payload: JSON.stringify({
      type: "toast",
      message: toast.message,
      toast_type: toast.toastType,
      duration: toast.durationMs / 1000,
      action: toast.action,
      action_label: toast.actionLabel,
    }),
  });
};

export const dismissPillToast = async (): Promise<void> => {
  releasePillFlashHold();
  await invoke("sync_native_pill_assistant", {
    payload: JSON.stringify({ type: "dismiss_toast" }),
  });
};

export const sendPillFlashMessage = (message: string): void => {
  sendPillToast({
    message,
    toastType: "info",
    durationMs: PILL_FLASH_DEFAULT_DURATION_MS,
    action: null,
    actionLabel: null,
  }).catch(console.error);
};

export const sendPillFireworks = (message: string): void => {
  holdPillVisibleForFlash(PILL_FIREWORKS_DURATION_MS);
  invoke("sync_native_pill_assistant", {
    payload: JSON.stringify({ type: "fireworks", message }),
  }).catch(console.error);
};

export const sendPillFlame = (message: string): void => {
  holdPillVisibleForFlash(PILL_FLAME_DURATION_MS);
  invoke("sync_native_pill_assistant", {
    payload: JSON.stringify({ type: "flame", message }),
  }).catch(console.error);
};

export const sendPillFlashBlue = (): void => {
  invoke("sync_native_pill_assistant", {
    payload: JSON.stringify({ type: "flash_blue" }),
  }).catch(console.error);
};

const clipTranscriptToLastWords = (text: string, maxWords = 10): string => {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text;
  return "..." + words.slice(-maxWords).join(" ");
};

export const sendPillBroadcastTranscript = (text: string): void => {
  const clipped = clipTranscriptToLastWords(text);
  invoke("sync_native_pill_assistant", {
    payload: JSON.stringify({ type: "broadcast_transcript", text: clipped }),
  }).catch(console.error);
};
