import { Box, Stack, Typography } from "@mui/material";
import { FormattedMessage } from "react-intl";
import { Virtuoso } from "react-virtuoso";
import { useNoteTranscriptEntries } from "../../hooks/note.hooks";
import { formatNoteDuration } from "../../utils/note.utils";
import type { NoteTranscriptEntry } from "../../utils/note-transcript.utils";

const TranscriptEntry = ({ entry }: { entry: NoteTranscriptEntry }) => (
  <Stack spacing={0.25} sx={{ pb: 2 }}>
    {(entry.startMs !== null || entry.speaker !== null) && (
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ fontVariantNumeric: "tabular-nums" }}
      >
        {entry.speaker !== null && (
          <Box component="span" sx={{ fontWeight: 600 }}>
            <FormattedMessage
              defaultMessage="Speaker {number}"
              values={{ number: entry.speaker + 1 }}
            />
          </Box>
        )}
        {entry.speaker !== null && entry.startMs !== null && " · "}
        {entry.startMs !== null && formatNoteDuration(entry.startMs)}
      </Typography>
    )}
    <Typography variant="body1" sx={{ whiteSpace: "pre-wrap" }}>
      {entry.text}
    </Typography>
  </Stack>
);

/**
 * The transcript, virtualized against the note page's scroller so multi-hour
 * meetings stay responsive.
 */
export const NoteTranscript = ({
  noteId,
  scrollParent,
}: {
  noteId: string;
  scrollParent: HTMLElement | null;
}) => {
  const entries = useNoteTranscriptEntries(noteId);

  if (entries.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        <FormattedMessage defaultMessage="No speech was detected in this recording." />
      </Typography>
    );
  }
  if (!scrollParent) {
    return null;
  }

  return (
    <Virtuoso
      customScrollParent={scrollParent}
      data={entries}
      computeItemKey={(_, entry) => entry.key}
      itemContent={(_, entry) => <TranscriptEntry entry={entry} />}
      increaseViewportBy={600}
    />
  );
};
