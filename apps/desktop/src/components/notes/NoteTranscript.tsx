import { Stack, Typography } from "@mui/material";
import { FormattedMessage } from "react-intl";
import { useAppStore } from "../../store";
import {
  formatNoteDuration,
  getNoteSegmentOffsetsMs,
} from "../../utils/note.utils";

type TranscriptEntry = {
  key: string;
  startMs: number | null;
  speaker: number | null;
  text: string;
};

export const NoteTranscript = ({ noteId }: { noteId: string }) => {
  const segments = useAppStore(
    (state) => state.noteSegmentsByNoteId[noteId] ?? [],
  );
  const offsets = getNoteSegmentOffsetsMs(segments);
  const entries = segments.flatMap((segment): TranscriptEntry[] => {
    const transcript = segment.transcript;
    if (!transcript?.text.trim()) {
      return [];
    }
    if (transcript.utterances.length === 0) {
      return [
        {
          key: segment.id,
          startMs: null,
          speaker: null,
          text: transcript.text,
        },
      ];
    }
    const offset = offsets.get(segment.id) ?? 0;
    return transcript.utterances.map((utterance, index) => ({
      key: `${segment.id}-${index}`,
      startMs: offset + utterance.startMs,
      speaker: utterance.speaker,
      text: utterance.text,
    }));
  });

  if (entries.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        <FormattedMessage defaultMessage="No speech was detected in this recording." />
      </Typography>
    );
  }

  return (
    <Stack spacing={2}>
      {entries.map((entry) => (
        <Stack key={entry.key} spacing={0.25}>
          {(entry.startMs !== null || entry.speaker !== null) && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ fontVariantNumeric: "tabular-nums" }}
            >
              {entry.speaker !== null && (
                <FormattedMessage
                  defaultMessage="Speaker {number}"
                  values={{ number: entry.speaker + 1 }}
                />
              )}
              {entry.speaker !== null && entry.startMs !== null && " · "}
              {entry.startMs !== null && formatNoteDuration(entry.startMs)}
            </Typography>
          )}
          <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
            {entry.text}
          </Typography>
        </Stack>
      ))}
    </Stack>
  );
};
