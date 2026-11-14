import PauseRounded from "@mui/icons-material/PauseRounded";
import { Box, Chip, Tooltip } from "@mui/material";
import { keyframes } from "@mui/material/styles";
import { useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import { getNotePath } from "../../hooks/note.hooks";
import { useAppStore } from "../../store";
import {
  formatNoteDuration,
  getActiveNoteId,
  getIsNoteCapturing,
  getNoteElapsedMs,
} from "../../utils/note.utils";

const pulse = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
`;

export const RecordingDot = ({ size = 8 }: { size?: number }) => (
  <Box
    component="span"
    aria-hidden
    sx={{
      display: "inline-block",
      width: size,
      height: size,
      borderRadius: "50%",
      bgcolor: "error.main",
      flexShrink: 0,
      animation: `${pulse} 1.6s ease-in-out infinite`,
      "@media (prefers-reduced-motion: reduce)": { animation: "none" },
    }}
  />
);

/** Shows the meeting in progress anywhere in the dashboard and returns to it. */
export const MeetingIndicatorChip = () => {
  const intl = useIntl();
  const navigate = useNavigate();
  const meeting = useAppStore((state) => {
    const noteId = getActiveNoteId(state);
    if (!noteId) {
      return null;
    }
    return {
      noteId,
      isCapturing: getIsNoteCapturing(state, noteId),
      elapsed: formatNoteDuration(getNoteElapsedMs(state, noteId)),
    };
  });

  if (!meeting) {
    return null;
  }

  const label = meeting.isCapturing
    ? intl.formatMessage(
        { defaultMessage: "Recording {elapsed}" },
        { elapsed: meeting.elapsed },
      )
    : intl.formatMessage(
        { defaultMessage: "Paused {elapsed}" },
        { elapsed: meeting.elapsed },
      );

  return (
    <Tooltip
      title={intl.formatMessage({ defaultMessage: "Open meeting notes" })}
    >
      <Chip
        size="small"
        clickable
        onClick={() => navigate(getNotePath(meeting.noteId))}
        icon={
          meeting.isCapturing ? (
            <Box sx={{ display: "flex", pl: 0.75 }}>
              <RecordingDot />
            </Box>
          ) : (
            <PauseRounded />
          )
        }
        label={label}
        aria-label={label}
        sx={{
          height: 24,
          bgcolor: "level1",
          color: "text.secondary",
          fontWeight: 500,
          fontVariantNumeric: "tabular-nums",
          "&:hover": { bgcolor: "level2" },
          "& .MuiChip-icon": { color: "inherit", fontSize: 16 },
        }}
      />
    </Tooltip>
  );
};
