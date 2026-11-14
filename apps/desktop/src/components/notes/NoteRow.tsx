import DeleteOutlineRounded from "@mui/icons-material/DeleteOutlineRounded";
import { Box, Stack, Tooltip, Typography } from "@mui/material";
import { Fragment, memo } from "react";
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

/** The row's second line when not searching: length, plus the state until ready. */
const NoteRowState = ({ noteId }: { noteId: string }) => {
  const status = useAppStore((state) => state.noteById[noteId]?.status);
  const durationMs = useAppStore(
    (state) => state.noteById[noteId]?.durationMs ?? 0,
  );
  const isImport = useAppStore(
    (state) => state.noteById[noteId]?.source === "import",
  );
  const activity = useAppStore((state) => {
    const current = state.notes.cloudActivityByNoteId[noteId];
    if (current?.kind !== "uploading") return current?.kind ?? null;
    const percent =
      current.totalBytes > 0
        ? Math.round((current.uploadedBytes / current.totalBytes) * 100)
        : 0;
    return `uploading:${percent}`;
  });
  const isCapturing = useAppStore(
    (state) => state.notes.capture?.noteId === noteId,
  );
  const elapsed = useAppStore((state) =>
    formatNoteDuration(getNoteElapsedMs(state, noteId)),
  );

  const length = isImport ? (
    <FormattedMessage defaultMessage="Imported" />
  ) : (
    formatNoteDuration(durationMs)
  );

  if (isCapturing) {
    return (
      <Stack
        component="span"
        direction="row"
        alignItems="center"
        spacing={0.75}
      >
        <RecordingDot />
        <Box component="span" sx={{ color: "error.main" }}>
          <FormattedMessage
            defaultMessage="Recording {elapsed}"
            values={{ elapsed }}
          />
        </Box>
      </Stack>
    );
  }

  switch (status) {
    case "recording":
    case "paused":
      return (
        <FormattedMessage
          defaultMessage="Paused {elapsed}"
          values={{ elapsed }}
        />
      );
    case "pending":
    case "processing":
      return (
        <>
          {length}
          {" · "}
          {activity === "waiting-for-connection" ? (
            <FormattedMessage defaultMessage="Waiting for connection" />
          ) : activity?.startsWith("uploading:") ? (
            <FormattedMessage
              defaultMessage="Uploading {percent}%"
              values={{ percent: activity.split(":")[1] }}
            />
          ) : activity === "server-busy" ? (
            <FormattedMessage defaultMessage="Queued" />
          ) : (
            <FormattedMessage defaultMessage="Processing" />
          )}
        </>
      );
    case "failed":
      return (
        <>
          {length}
          {" · "}
          <Box component="span" sx={{ color: "error.main" }}>
            <FormattedMessage defaultMessage="Didn't finish" />
          </Box>
        </>
      );
    default:
      return length;
  }
};

export type NoteRowProps = {
  noteId: string;
  /** Search results show a matching snippet instead of the state line. */
  snippet: string | null;
  highlightTerms: string[];
  /** "time" in day groups; "date" in search results, which aren't grouped. */
  when: "time" | "date";
  onDelete: (noteId: string) => void;
};

export const NoteRow = memo(function NoteRow({
  noteId,
  snippet,
  highlightTerms,
  when,
  onDelete,
}: NoteRowProps) {
  const intl = useIntl();
  const title = useAppStore((state) => state.noteById[noteId]?.title);
  const createdAt = useAppStore((state) => state.noteById[noteId]?.createdAt);
  if (title === undefined || !createdAt) {
    return null;
  }

  const deleteLabel = intl.formatMessage({ defaultMessage: "Delete note" });

  return (
    <ListTile
      href={getNotePath(noteId)}
      title={<HighlightedText text={title} terms={highlightTerms} />}
      subtitle={
        <Box
          component="span"
          sx={{
            display: "-webkit-box",
            WebkitLineClamp: snippet ? 2 : 1,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {snippet ? (
            <HighlightedText text={snippet} terms={highlightTerms} />
          ) : (
            <NoteRowState noteId={noteId} />
          )}
        </Box>
      }
      trailing={
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ fontVariantNumeric: "tabular-nums", fontWeight: 400 }}
        >
          {when === "time"
            ? intl.formatTime(createdAt, { timeStyle: "short" })
            : intl.formatDate(createdAt, { month: "short", day: "numeric" })}
        </Typography>
      }
      trailingHover={
        <Tooltip title={deleteLabel}>
          <DeleteOutlineRounded fontSize="small" aria-label={deleteLabel} />
        </Tooltip>
      }
      trailingOnClick={() => onDelete(noteId)}
      sx={{ mx: -2, width: "auto" }}
    />
  );
});
