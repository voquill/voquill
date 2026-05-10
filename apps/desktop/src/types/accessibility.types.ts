/**
 * Information about the currently focused text field.
 * Does not include screen context - use ScreenContextInfo for that.
 */
export type TextFieldInfo = {
  /** Current cursor position (index) in the text field. Null if not available. */
  cursorPosition: number | null;
  /** Number of characters currently selected. Null if not available. */
  selectionLength: number | null;
  /** Full text content of the focused text field. Null if not available. */
  textContent: string | null;
};

/**
 * Screen context information gathered from elements around the focused field.
 */
export type ScreenContextInfo = {
  /** Text content gathered from other elements on the screen for context. Null if not available. */
  screenContext: string | null;
};

/**
 * OCR text captured from the frontmost macOS window. Null if unavailable.
 */
export type ScreenCaptureContext = string | null;
