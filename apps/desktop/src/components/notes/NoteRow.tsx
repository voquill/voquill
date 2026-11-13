import DeleteOutlineRounded from "@mui/icons-material/DeleteOutlineRounded";
import { CircularProgress, Stack, Tooltip, Typography } from "@mui/material";
import { Fragment } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { getNotePath } from "../../hooks/note.hooks";
import { useAppStore } from "../../store";
import { formatNoteDuration, getNoteElapsedMs } from "../../utils/note.utils";
import { splitHighlights } from "../../utils/note-search.utils";
import { ListTile } from "../common/ListTile";
import { RecordingDot } from "./MeetingIndicatorChip";

const HighlightedText = ({
  text,
  terms,
}: {
  text: string;
  terms: string[];
}) => (
  <>
    {splitHighlights(text, terms).map((part, index) =>
      part.match ? (
        <Typography
          key={index}
          component="mark"
          variant="inherit"
          sx={{
            bgcolor: "transparent",
            color: "text.primary",
            fontWeight: 700,
          }}
        >
          {part.text}
        </Typography>
      ) : (
        <Fragment key={index}>{part.text}</Fragment>
      ),
    )}
  </>
);

const NoteRowStatus = ({ noteId }: { noteId: string }) => {
  const status = useAppStore((state) => state.noteById[noteId]?.status);
  const isImport = useAppStore(
    (state) => state.noteById[noteId]?.source === "import",
  );
  const isCapturing = useAppStore(
    (state) => state.notes.capture?.noteId === noteId,
  );
  const elapsed = useAppStore((state) =>
    formatNoteDuration(getNoteElapsedMs(state, noteId)),
  );

  if (isCapturing) {
    return (
      <Stack direction="row" alignItems="center" spacing={0.75}>
        <RecordingDot />
        <Typography
          variant="body2"
          color="error"
          sx={{ fontVariantNumeric: "tabular-nums" }}
        >
          {elapsed}
        </Typography>
      </Stack>
    );
  }

  switch (status) {
    case "recording":
    case "paused":
      return (
        <Typography variant="body2" color="text.secondary">
          <FormattedMessage defaultMessage="Paused" />
        </Typography>
      );
    case "pending":
    case "processing":
      return (
        <Stack direction="row" alignItems="center" spacing={0.75}>
          <CircularProgress size={12} />
          <Typography variant="body2" color="text.secondary">
            <FormattedMessage defaultMessage="Processing" />
          </Typography>
        </Stack>
      );
    case "failed":
      return (
        <Typography variant="body2" color="error">
          <FormattedMessage defaultMessage="Failed" />
        </Typography>
      );
    default:
      return (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ fontVariantNumeric: "tabular-nums" }}
        >
          {isImport ? <FormattedMessage defaultMessage="Imported" /> : elapsed}
        </Typography>
      );
  }
};

export type NoteRowProps = {
  noteId: string;
  snippet: string | null;
  highlightTerms: string[];
  onDelete: (noteId: string) => void;
};

export const NoteRow = ({
  noteId,
  snippet,
  highlightTerms,
  onDelete,
}: NoteRowProps) => {
  const intl = useIntl();
  const note = useAppStore((state) => state.noteById[noteId]);
  if (!note) {
    return null;
  }

  const date = intl.formatDate(note.createdAt, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <ListTile
      href={getNotePath(noteId)}
      title={<HighlightedText text={note.title} terms={highlightTerms} />}
      subtitle={
        <Stack component="span" spacing={0.25}>
          <span>{date}</span>
          {snippet && (
            <Typography
              component="span"
              variant="body2"
              color="text.secondary"
              sx={{
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              <HighlightedText text={snippet} terms={highlightTerms} />
            </Typography>
          )}
        </Stack>
      }
      trailing={<NoteRowStatus noteId={noteId} />}
      trailingHover={
        <Tooltip title={intl.formatMessage({ defaultMessage: "Delete note" })}>
          <DeleteOutlineRounded
            fontSize="small"
            aria-label={intl.formatMessage({ defaultMessage: "Delete note" })}
          />
        </Tooltip>
      }
      trailingOnClick={() => onDelete(noteId)}
      sx={{ mx: -2 }}
    />
  );
};
