import { platform } from "@tauri-apps/plugin-os";

export type Platform = "macos" | "windows" | "linux" | "unknown";

let cachedPlatform: Platform | null = null;

export const getPlatform = (): Platform => {
  if (cachedPlatform) {
    return cachedPlatform;
  }

  const platformName = platform();
  switch (platformName) {
    case "macos":
      cachedPlatform = "macos";
      break;
    case "windows":
      cachedPlatform = "windows";
      break;
    case "linux":
      cachedPlatform = "linux";
      break;
    default:
      cachedPlatform = "unknown";
      break;
  }

  return cachedPlatform;
};

type CursorToViewportParams = {
  cursorX: number;
  cursorY: number;
  visibleX: number;
  visibleY: number;
  visibleHeight: number;
  scaleFactor?: number;
};

export const cursorToViewportPosition = (
  params: CursorToViewportParams,
): { x: number; y: number } => {
  const {
    cursorX,
    cursorY,
    visibleX,
    visibleY,
    visibleHeight,
    scaleFactor = 1,
  } = params;
  const plt = getPlatform();

  if (plt === "macos") {
    const x = Math.round(cursorX - visibleX);
    const y = Math.round(visibleHeight - (cursorY - visibleY));
    return { x, y };
  } else {
    // Windows/Linux: coordinates are in physical pixels, convert to CSS pixels
    const x = Math.round((cursorX - visibleX) / scaleFactor);
    const y = Math.round((cursorY - visibleY) / scaleFactor);
    return { x, y };
  }
};

export const getOverlayBottomOffset = (): number => {
  const plt = getPlatform();
  switch (plt) {
    case "macos":
      return 12;
    case "linux":
      return 8;
    case "windows":
      return 8;
    default:
      return 12;
  }
};
