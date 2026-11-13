import ArrowBackRounded from "@mui/icons-material/ArrowBackRounded";
import AutorenewRounded from "@mui/icons-material/AutorenewRounded";
import ContentCopyRounded from "@mui/icons-material/ContentCopyRounded";
import DeleteOutlineRounded from "@mui/icons-material/DeleteOutlineRounded";
import MicRounded from "@mui/icons-material/MicRounded";
import PauseRounded from "@mui/icons-material/PauseRounded";
import QuestionAnswerOutlined from "@mui/icons-material/QuestionAnswerOutlined";
import StopRounded from "@mui/icons-material/StopRounded";
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Container,
  IconButton,
  LinearProgress,
  Link,
  Stack,
  Tab,
  Tabs,
  Tooltip,
  Typography,
} from "@mui/material";
import type { Note } from "@voquill/types";
import { useState, type ReactNode } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useNavigate, useParams } from "react-router-dom";
import { showErrorSnackbar, showSnackbar } from "../../actions/app.actions";
import {
  CAPTURE_INTERRUPTED_ERROR_CODE,
  loadNoteSegments,
  openNotesAsk,
  pauseMeetingNote,
  dropNoteSegment,
  regenerateNote,
  renameNote,
  resumeMeetingNote,
  retryNote,
  retryNoteSegment,
  stopMeetingNote,
} from "../../actions/note.actions";
import { openUpgradePlanDialog } from "../../actions/pricing.actions";
import { describeNoteError } from "../../utils/note-error.utils";
import { useAsyncEffect } from "../../hooks/async.hooks";
import { getNotePath } from "../../hooks/note.hooks";
import { produceAppState, useAppStore } from "../../store";
import {
  formatNoteDuration,
  getNoteElapsedMs,
  getNoteGenerationAvailableFor,
  getNoteTranscriptText,
} from "../../utils/note.utils";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { EditTypography } from "../common/EditTypography";
import { DeleteNoteDialog } from "./DeleteNoteDialog";
import { RecordingDot } from "./MeetingIndicatorChip";
import { NoteMarkdown } from "./NoteMarkdown";
import { NoteTranscript } from "./NoteTranscript";
import { PersonalNotesEditor } from "./PersonalNotesEditor";

const NOTES_PATH = "/dashboard/notes";

const openPostProcessingSettings = () => {
  produceAppState((draft) => {
    draft.settings.aiPostProcessingDialogOpen = true;
  });
};

const Section = ({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) => (
  <Stack spacing={1}>
    <Typography variant="subtitle2" color="text.secondary">
      {title}
    </Typography>
    {children}
  </Stack>
);

const IconAction = ({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) => (
  <Tooltip title={label}>
    <span>
      <IconButton onClick={onClick} disabled={disabled} aria-label={label}>
        {children}
      </IconButton>
    </span>
  </Tooltip>
);

const useResumeNote = () => {
  const intl = useIntl();
  const navigate = useNavigate();
  return async (noteId: string) => {
    try {
      const otherNoteId = await resumeMeetingNote(noteId);
      if (otherNoteId) {
        showSnackbar(
          intl.formatMessage({
            defaultMessage:
              "Another meeting is being recorded. Stop it before resuming this one.",
          }),
        );
        navigate(getNotePath(otherNoteId));
      }
    } catch {
      showErrorSnackbar(
        intl.formatMessage({
          defaultMessage:
            "Couldn't start recording. Check that your microphone is connected and allowed.",
        }),
      );
    }
  };
};

const RecordingPanel = ({ note }: { note: Note }) => {
  const intl = useIntl();
  const isCapturing = useAppStore(
    (state) => state.notes.capture?.noteId === note.id,
  );
  const level = useAppStore((state) =>
    state.notes.capture?.noteId === note.id ? state.notes.capture.level : 0,
  );
  const elapsed = useAppStore((state) =>
    formatNoteDuration(getNoteElapsedMs(state, note.id)),
  );
  const resumeNote = useResumeNote();
  const interrupted = note.error?.code === CAPTURE_INTERRUPTED_ERROR_CODE;

  return (
    <Stack spacing={3}>
      {interrupted && !isCapturing && (
        <Alert severity="warning">
          <FormattedMessage defaultMessage="Recording stopped unexpectedly, for example because the microphone was disconnected or Voquill closed. Everything recorded until then is saved. Resume to keep recording, or Stop to write the notes." />
        </Alert>
      )}
      <Stack alignItems="center" spacing={2} sx={{ py: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1.5}>
          {isCapturing && <RecordingDot size={12} />}
          <Typography
            variant="h3"
            fontWeight={600}
            sx={{ fontVariantNumeric: "tabular-nums" }}
            aria-live="off"
          >
            {elapsed}
          </Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary">
          {isCapturing ? (
            <FormattedMessage defaultMessage="Recording. You can leave this page; recording continues." />
          ) : (
            <FormattedMessage defaultMessage="Paused" />
          )}
        </Typography>
        {isCapturing && (
          <LinearProgress
            variant="determinate"
            value={Math.min(100, level * 400)}
            aria-label={intl.formatMessage({ defaultMessage: "Input level" })}
            sx={{ width: 160, height: 4, borderRadius: 2 }}
          />
        )}
        <Stack direction="row" spacing={1.5}>
          {isCapturing ? (
            <Button
              variant="outlined"
              size="large"
              startIcon={<PauseRounded />}
              onClick={() => pauseMeetingNote(note.id).catch(showErrorSnackbar)}
            >
              <FormattedMessage defaultMessage="Pause" />
            </Button>
          ) : (
            <Button
              variant="outlined"
              size="large"
              startIcon={<MicRounded />}
              onClick={() => resumeNote(note.id)}
            >
              <FormattedMessage defaultMessage="Resume" />
            </Button>
          )}
          <Button
            variant="contained"
            color="error"
            size="large"
            startIcon={<StopRounded />}
            onClick={() => stopMeetingNote(note.id).catch(showErrorSnackbar)}
            sx={{ px: 4 }}
          >
            <FormattedMessage defaultMessage="Stop" />
          </Button>
        </Stack>
      </Stack>
      <Section title={<FormattedMessage defaultMessage="My notes" />}>
        <PersonalNotesEditor noteId={note.id} />
      </Section>
    </Stack>
  );
};

type ProgressView = {
  label: ReactNode;
  percent: number | null;
  hint: ReactNode;
};

const useProcessingProgress = (note: Note): ProgressView => {
  const activity = useAppStore(
    (state) => state.notes.cloudActivityByNoteId[note.id] ?? null,
  );
  const local = useAppStore((state) => {
    const audio = (state.noteSegmentsByNoteId[note.id] ?? []).filter(
      (segment) => segment.kind === "audio",
    );
    const total = audio.reduce((sum, segment) => sum + segment.durationMs, 0);
    const done = audio.reduce(
      (sum, segment) =>
        sum + Math.min(segment.transcribedMs, segment.durationMs),
      0,
    );
    return {
      transcribing: audio.some((segment) => segment.status !== "transcribed"),
      percent: total > 0 ? Math.round((done / total) * 100) : 0,
    };
  });
  const leaveHint = (
    <FormattedMessage defaultMessage="You can leave this page. The note will be ready here when processing finishes." />
  );

  if (note.storage === "cloud") {
    if (activity?.kind === "uploading") {
      const percent =
        activity.totalBytes > 0
          ? Math.round((activity.uploadedBytes / activity.totalBytes) * 100)
          : 0;
      return {
        label: (
          <FormattedMessage
            defaultMessage="Uploading the recording… {percent}%"
            values={{ percent }}
          />
        ),
        percent,
        hint: leaveHint,
      };
    }
    if (activity?.kind === "waiting-for-connection") {
      return {
        label: <FormattedMessage defaultMessage="Waiting for a connection" />,
        percent: null,
        hint: (
          <FormattedMessage defaultMessage="Your recording is safe on this device and is sent to Voquill as soon as you're back online." />
        ),
      };
    }
    if (activity?.kind === "server-busy") {
      return {
        label: (
          <FormattedMessage defaultMessage="Waiting for other meetings to finish" />
        ),
        percent: null,
        hint: leaveHint,
      };
    }
    return {
      label:
        note.status === "pending" ? (
          <FormattedMessage defaultMessage="Preparing…" />
        ) : (
          <FormattedMessage defaultMessage="Transcribing and writing notes…" />
        ),
      percent: null,
      hint: leaveHint,
    };
  }

  return local.transcribing
    ? {
        label: (
          <FormattedMessage
            defaultMessage="Transcribing… {percent}%"
            values={{ percent: local.percent }}
          />
        ),
        percent: local.percent,
        hint: leaveHint,
      }
    : {
        label: <FormattedMessage defaultMessage="Writing notes…" />,
        percent: null,
        hint: leaveHint,
      };
};

const ProcessingPanel = ({ note }: { note: Note }) => {
  const progress = useProcessingProgress(note);
  return (
    <Stack spacing={3}>
      <Stack spacing={1} sx={{ py: 2 }} role="status">
        <Typography variant="body1" fontWeight={600}>
          {progress.label}
        </Typography>
        <LinearProgress
          variant={progress.percent === null ? "indeterminate" : "determinate"}
          value={progress.percent ?? 0}
        />
        <Typography variant="body2" color="text.secondary">
          {progress.hint}
        </Typography>
      </Stack>
      <Section title={<FormattedMessage defaultMessage="My notes" />}>
        <PersonalNotesEditor noteId={note.id} />
      </Section>
    </Stack>
  );
};

const NoteProblem = ({
  code,
  action,
  severity = "error",
}: {
  code: string | undefined;
  action?: ReactNode;
  severity?: "error" | "warning";
}) => {
  const intl = useIntl();
  const description = describeNoteError(intl, code);
  return (
    <Alert
      severity={severity}
      action={
        <Stack direction="row" spacing={1}>
          {description.upgrade && (
            <Button
              color="inherit"
              size="small"
              onClick={openUpgradePlanDialog}
            >
              <FormattedMessage defaultMessage="Upgrade" />
            </Button>
          )}
          {action}
        </Stack>
      }
    >
      <AlertTitle>{description.title}</AlertTitle>
      {description.body}{" "}
      {code !== "audio_missing" && (
        <FormattedMessage defaultMessage="Your audio is safe on this device." />
      )}
    </Alert>
  );
};

const FailedPanel = ({ note }: { note: Note }) => (
  <Stack spacing={3}>
    <NoteProblem
      code={note.error?.code}
      action={
        <Button
          color="inherit"
          size="small"
          onClick={() => retryNote(note.id).catch(showErrorSnackbar)}
        >
          <FormattedMessage defaultMessage="Retry" />
        </Button>
      }
    />
    <Section title={<FormattedMessage defaultMessage="My notes" />}>
      <PersonalNotesEditor noteId={note.id} />
    </Section>
  </Stack>
);

/** Parts of a ready cloud note the server could not transcribe. */
const FailedSegments = ({ note }: { note: Note }) => {
  const [dropSegmentId, setDropSegmentId] = useState<string | null>(null);
  const failed = useAppStore((state) =>
    (state.noteSegmentsByNoteId[note.id] ?? []).filter(
      (segment) => segment.status === "failed",
    ),
  );
  if (note.storage !== "cloud" || failed.length === 0) {
    return null;
  }
  return (
    <Stack spacing={1}>
      {failed.map((segment) => (
        <NoteProblem
          key={segment.id}
          severity="warning"
          code={segment.audioPath ? segment.error?.code : "audio_missing"}
          action={
            <>
              {segment.audioPath && (
                <Button
                  color="inherit"
                  size="small"
                  onClick={() =>
                    retryNoteSegment(note.id, segment.id).catch(
                      showErrorSnackbar,
                    )
                  }
                >
                  <FormattedMessage defaultMessage="Retry" />
                </Button>
              )}
              <Button
                color="inherit"
                size="small"
                onClick={() => setDropSegmentId(segment.id)}
              >
                <FormattedMessage defaultMessage="Remove part" />
              </Button>
            </>
          }
        />
      ))}
      <ConfirmDialog
        isOpen={dropSegmentId !== null}
        title={<FormattedMessage defaultMessage="Remove this part?" />}
        content={
          <FormattedMessage defaultMessage="Its recording is deleted from this device. The rest of the note stays." />
        }
        confirmLabel={<FormattedMessage defaultMessage="Remove" />}
        confirmButtonProps={{ color: "error" }}
        onCancel={() => setDropSegmentId(null)}
        onConfirm={() => {
          const segmentId = dropSegmentId;
          setDropSegmentId(null);
          if (segmentId) {
            dropNoteSegment(note.id, segmentId).catch(showErrorSnackbar);
          }
        }}
      />
    </Stack>
  );
};

type ReadyTab = "notes" | "mine" | "transcript";

const ReadyPanel = ({ note }: { note: Note }) => {
  const [tab, setTab] = useState<ReadyTab>("notes");
  const hasTranscript = useAppStore(
    (state) => getNoteTranscriptText(state, note.id).length > 0,
  );
  const generationAvailable = useAppStore((state) =>
    getNoteGenerationAvailableFor(state, note.id),
  );

  return (
    <Stack spacing={2}>
      <FailedSegments note={note} />
      <Tabs
        value={tab}
        onChange={(_, value: ReadyTab) => setTab(value)}
        sx={{ borderBottom: 1, borderColor: "divider" }}
      >
        <Tab
          value="notes"
          label={<FormattedMessage defaultMessage="Notes" />}
        />
        <Tab
          value="mine"
          label={<FormattedMessage defaultMessage="My notes" />}
        />
        <Tab
          value="transcript"
          label={<FormattedMessage defaultMessage="Transcript" />}
        />
      </Tabs>
      <Box role="tabpanel" sx={{ pb: 4 }}>
        {tab === "notes" &&
          (note.generatedNotes ? (
            <NoteMarkdown>{note.generatedNotes}</NoteMarkdown>
          ) : !hasTranscript ? (
            <Typography variant="body2" color="text.secondary">
              <FormattedMessage defaultMessage="No speech was detected, so there is nothing to summarize." />
            </Typography>
          ) : generationAvailable ? (
            <Typography variant="body2" color="text.secondary">
              <FormattedMessage defaultMessage="This note has no AI notes yet. Use Regenerate to write them from the transcript." />
            </Typography>
          ) : (
            <Typography variant="body2" color="text.secondary">
              <FormattedMessage defaultMessage="AI notes need post-processing, which is turned off. The transcript is ready." />{" "}
              <Link component="button" onClick={openPostProcessingSettings}>
                <FormattedMessage defaultMessage="Turn it on" />
              </Link>
            </Typography>
          ))}
        {tab === "mine" && (
          <PersonalNotesEditor noteId={note.id} minRows={12} />
        )}
        {tab === "transcript" && <NoteTranscript noteId={note.id} />}
      </Box>
    </Stack>
  );
};

export default function NotePage() {
  const intl = useIntl();
  const navigate = useNavigate();
  const { noteId = "" } = useParams();
  const note = useAppStore((state) => state.noteById[noteId]);
  const loaded = useAppStore((state) => state.notes.loaded);
  const generationAvailable = useAppStore((state) =>
    getNoteGenerationAvailableFor(state, noteId),
  );
  const transcript = useAppStore((state) =>
    getNoteTranscriptText(state, noteId),
  );
  const resumeNote = useResumeNote();
  const [confirmDelete, setConfirmDelete] = useState(false);

  useAsyncEffect(async () => {
    if (note) {
      await loadNoteSegments(noteId).catch(showErrorSnackbar);
    }
  }, [noteId, Boolean(note)]);

  const goBack = () => navigate(NOTES_PATH);

  if (!note) {
    return (
      <Container maxWidth="md" sx={{ pt: 2 }}>
        <Button startIcon={<ArrowBackRounded />} onClick={goBack}>
          <FormattedMessage defaultMessage="Notes" />
        </Button>
        {loaded && (
          <Typography
            color="text.secondary"
            sx={{ mt: 4, textAlign: "center" }}
          >
            <FormattedMessage defaultMessage="This note no longer exists." />
          </Typography>
        )}
      </Container>
    );
  }

  const isActive = note.status === "recording" || note.status === "paused";
  const isProcessing =
    note.status === "pending" || note.status === "processing";
  const isReady = note.status === "ready";

  const handleCopy = async () => {
    const text = note.generatedNotes ?? transcript;
    if (!text) return;
    await navigator.clipboard.writeText(text);
    showSnackbar(intl.formatMessage({ defaultMessage: "Copied to clipboard" }));
  };

  return (
    <Box sx={{ flex: 1, overflowY: "auto" }}>
      <Container key={note.id} maxWidth="md" sx={{ pt: 1, pb: 6 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
          <Tooltip
            title={intl.formatMessage({ defaultMessage: "Back to notes" })}
          >
            <IconButton
              onClick={goBack}
              aria-label={intl.formatMessage({
                defaultMessage: "Back to notes",
              })}
              sx={{ ml: -1 }}
            >
              <ArrowBackRounded />
            </IconButton>
          </Tooltip>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <EditTypography
              value={note.title}
              onChange={(next) => renameNote(note.id, String(next))}
              validate={(next) => String(next).trim().length > 0}
              typographyProps={{
                variant: "h5",
                fontWeight: 700,
                "aria-label": intl.formatMessage({
                  defaultMessage: "Note title, press Enter to rename",
                }),
              }}
              textFieldProps={{
                slotProps: {
                  htmlInput: {
                    "aria-label": intl.formatMessage({
                      defaultMessage: "Note title",
                    }),
                    style: { fontSize: "1.5rem", fontWeight: 700 },
                  },
                },
              }}
            />
          </Box>
          {isReady && (
            <>
              <IconAction
                label={intl.formatMessage({
                  defaultMessage: "Resume recording",
                })}
                onClick={() => resumeNote(note.id)}
              >
                <MicRounded />
              </IconAction>
              <IconAction
                label={
                  generationAvailable
                    ? intl.formatMessage({ defaultMessage: "Regenerate notes" })
                    : intl.formatMessage({
                        defaultMessage:
                          "Regenerating notes needs AI post-processing",
                      })
                }
                onClick={async () => {
                  const code = await regenerateNote(note.id);
                  if (code) {
                    const problem = describeNoteError(intl, code);
                    showSnackbar(`${problem.title}. ${problem.body}`);
                  }
                }}
                disabled={!generationAvailable || !transcript}
              >
                <AutorenewRounded />
              </IconAction>
              <IconAction
                label={intl.formatMessage({ defaultMessage: "Copy notes" })}
                onClick={handleCopy}
                disabled={!note.generatedNotes && !transcript}
              >
                <ContentCopyRounded />
              </IconAction>
            </>
          )}
          <IconAction
            label={intl.formatMessage({ defaultMessage: "Delete note" })}
            onClick={() => setConfirmDelete(true)}
          >
            <DeleteOutlineRounded />
          </IconAction>
          <Button
            variant="outlined"
            startIcon={<QuestionAnswerOutlined />}
            onClick={() => openNotesAsk(note.id)}
          >
            <FormattedMessage defaultMessage="Ask" />
          </Button>
        </Stack>

        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          {intl.formatDate(note.createdAt, {
            dateStyle: "full",
          })}
          {" · "}
          {intl.formatTime(note.createdAt, { timeStyle: "short" })}
        </Typography>

        {isActive && <RecordingPanel note={note} />}
        {isProcessing && <ProcessingPanel note={note} />}
        {note.status === "failed" && <FailedPanel note={note} />}
        {isReady && <ReadyPanel note={note} />}
      </Container>

      <DeleteNoteDialog
        noteId={confirmDelete ? note.id : null}
        onClose={() => setConfirmDelete(false)}
        onDeleted={goBack}
      />
    </Box>
  );
}
