import * as React from "react";
import {
  Typography,
  TextField,
  Box,
  type TypographyProps,
  type TextFieldProps,
} from "@mui/material";

type EditTypographyProps = {
  value: string | number;
  onChange: (next: string | number) => void;
  /** Force input mode. Defaults from typeof value. */
  type?: "number" | "text";
  /** Called when editing starts. */
  onEditStart?: () => void;
  /** Called when editing ends. accepted=true if committed. */
  onEditEnd?: (accepted: boolean, next: string | number) => void;
  /** Validate parsed value before commit. Return false to block commit. */
  validate?: (next: string | number) => boolean;
  /** Custom parse. Defaults: number=>finite(float), text=>raw string. */
  parse?: (raw: string, mode: "number" | "text") => string | number;
  /** Render display value. Defaults to String(value). */
  renderValue?: (value: string | number) => React.ReactNode;
  /** Function to render children when not editing. Receives value as parameter. */
  children?: (value: string | number) => React.ReactNode;
  /** Click to edit. Disable to manage mode externally. */
  editable?: boolean;
  /** Auto select text on enter edit. */
  autoSelect?: boolean;
  /** Props passthroughs */
  typographyProps?: TypographyProps;
  textFieldProps?: Omit<
    TextFieldProps,
    "value" | "onChange" | "onBlur" | "onKeyDown"
  >;
  /** Optional className and sx on wrapper */
  className?: string;
  sx?: TypographyProps["sx"];
};

export const EditTypography: React.FC<EditTypographyProps> = ({
  value,
  onChange,
  type,
  onEditStart,
  onEditEnd,
  validate,
  parse,
  renderValue,
  children,
  editable = true,
  autoSelect = true,
  typographyProps,
  textFieldProps,
  className,
  sx,
}) => {
  const mode: "number" | "text" =
    type ?? (typeof value === "number" ? "number" : "text");
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<string>("");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const measureRef = React.useRef<HTMLSpanElement>(null);

  // If parent value changes while not editing, reflect it.
  React.useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);

  // Focus when entering edit.
  React.useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      if (autoSelect) inputRef.current.select();
    }
  }, [editing, autoSelect]);

  const defaultParse = React.useCallback(
    (raw: string): string | number => {
      if (mode === "text") return raw;
      // number mode
      const n = Number.parseFloat(raw.replace(/,/g, ""));
      return Number.isFinite(n) ? n : value; // fall back to last value if NaN
    },
    [mode, value],
  );

  const tryCommit = React.useCallback(() => {
    const parsed = (parse ?? defaultParse)(draft, mode);
    if (validate && !validate(parsed)) return; // block commit
    setEditing(false);
    onChange(parsed);
    onEditEnd?.(true, parsed);
  }, [draft, parse, defaultParse, mode, validate, onChange, onEditEnd]);

  const cancel = React.useCallback(() => {
    setEditing(false);
    setDraft(String(value)); // revert draft
    onEditEnd?.(false, value);
  }, [value, onEditEnd]);

  const handleKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      tryCommit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  const startEdit = () => {
    if (!editable || editing) return;
    setDraft(String(value));
    setEditing(true);
    onEditStart?.();
  };

  // Calculate the width needed for the current text
  const getTextWidth = React.useCallback(() => {
    if (!measureRef.current) return "auto";

    // Create a temporary element to measure text width
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return "auto";

    // Use the same font properties as the Typography component
    const computedStyle = window.getComputedStyle(measureRef.current);
    context.font = `${computedStyle.fontSize} ${computedStyle.fontFamily}`;

    // Measure the draft text width and add some padding
    const textWidth = context.measureText(draft || String(value)).width;
    return Math.max(textWidth + 20, 50); // minimum width of 50px, plus 20px padding
  }, [draft, value]);

  return (
    <Box
      component="span"
      className={className}
      sx={{
        display: "inline-flex",
        alignItems: "center",
        ...(editable &&
          !editing && {
            "&:hover": {
              backgroundColor: "action.hover",
              borderRadius: 1,
            },
          }),
        ...sx,
      }}
      onClick={startEdit}
    >
      {/* Hidden span for measuring text width */}
      <Typography
        {...typographyProps}
        ref={measureRef}
        aria-hidden
        sx={{
          ...typographyProps?.sx,
          position: "absolute",
          visibility: "hidden",
          whiteSpace: "nowrap",
        }}
      >
        {draft || String(value)}
      </Typography>

      {editing ? (
        <TextField
          inputRef={inputRef}
          variant="standard"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={tryCommit}
          onKeyDown={handleKeyDown}
          type={mode === "number" ? "text" : "text"}
          size="small"
          sx={{
            width: getTextWidth(),
            minWidth: "50px",
            ...textFieldProps?.sx,
          }}
          {...textFieldProps}
        />
      ) : (
        <Typography
          role={editable ? "button" : undefined}
          tabIndex={editable ? 0 : -1}
          onKeyDown={(e) => {
            if (!editable) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              startEdit();
            }
          }}
          {...typographyProps}
          sx={{
            cursor: editable ? "text" : "default",
            px: 0.5,
            py: 0.25,
            borderRadius: 1,
            ...typographyProps?.sx,
          }}
        >
          {children
            ? children(value)
            : renderValue
              ? renderValue(value)
              : String(value)}
        </Typography>
      )}
    </Box>
  );
};
