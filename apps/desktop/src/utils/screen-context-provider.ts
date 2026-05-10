import { invoke } from "@tauri-apps/api/core";
import type { ScreenCaptureContext } from "../types/accessibility.types";
import { getLogger } from "./log.utils";

export const getScreenCaptureContext =
  async (): Promise<ScreenCaptureContext> => {
    try {
      return await invoke<ScreenCaptureContext>("get_screen_capture_context");
    } catch (error) {
      getLogger().verbose(
        `[screen-capture] getScreenCaptureContext failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  };
