import { getIntl } from "../i18n/intl";
import { ToastAction, ToastType } from "../types/toast.types";
import {
  dismissPillToast,
  PILL_FLASH_DEFAULT_DURATION_MS,
  sendPillToast,
} from "../utils/overlay.utils";

function getActionLabel(action: ToastAction): string {
  const intl = getIntl();
  switch (action) {
    case "upgrade":
      return intl.formatMessage({ defaultMessage: "Upgrade" });
    case "open_agent_settings":
      return intl.formatMessage({ defaultMessage: "Fix" });
    case "surface_window":
      return intl.formatMessage({ defaultMessage: "Open" });
    case "confirm_cancel_transcription":
      return intl.formatMessage({ defaultMessage: "Yes, cancel" });
  }
}

export type ShowToastOptions = {
  message: string;
  toastType?: ToastType;
  duration?: number;
  action?: ToastAction;
};

export async function showToast(options: ShowToastOptions): Promise<void> {
  await sendPillToast({
    message: options.message,
    toastType: options.toastType ?? "info",
    durationMs: options.duration ?? PILL_FLASH_DEFAULT_DURATION_MS,
    action: options.action ?? null,
    actionLabel: options.action ? getActionLabel(options.action) : null,
  });
}

export async function dismissToast(): Promise<void> {
  await dismissPillToast();
}
