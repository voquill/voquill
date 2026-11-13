import ArrowBackRounded from "@mui/icons-material/ArrowBackRounded";
import AutorenewRounded from "@mui/icons-material/AutorenewRounded";
import CalendarTodayOutlined from "@mui/icons-material/CalendarTodayOutlined";
import CloudOffOutlined from "@mui/icons-material/CloudOffOutlined";
import CloudOutlined from "@mui/icons-material/CloudOutlined";
import ContentCopyRounded from "@mui/icons-material/ContentCopyRounded";
import DeleteOutlineRounded from "@mui/icons-material/DeleteOutlineRounded";
import ErrorOutlineRounded from "@mui/icons-material/ErrorOutlineRounded";
import FileUploadOutlined from "@mui/icons-material/FileUploadOutlined";
import HourglassEmptyRounded from "@mui/icons-material/HourglassEmptyRounded";
import LaptopOutlined from "@mui/icons-material/LaptopOutlined";
import MicRounded from "@mui/icons-material/MicRounded";
import PauseRounded from "@mui/icons-material/PauseRounded";
import ScheduleOutlined from "@mui/icons-material/ScheduleOutlined";
import StopRounded from "@mui/icons-material/StopRounded";
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  CircularProgress,
  Container,
  IconButton,
  LinearProgress,
  Link,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  API_KEY_PROVIDERS,
  type ApiKeyProvider,
  type Note,
  type NoteError,
  type NoteProcessor,
} from "@voquill/types";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useNavigate, useParams } from "react-router-dom";
import { showErrorSnackbar, showSnackbar } from "../../actions/app.actions";
import {
  dropNoteSegment,
  loadNoteSegments,
  NoteRecordingBlockedError,
  pauseMeetingNote,
  processNoteInVoquillCloud,
  RECOVERED_AUDIO_ERROR_CODE,
  regenerateNote,
  renameNote,
  resumeMeetingNote,
  retryNote,
  retryNoteSegment,
  setNoteView,
  setOpenNote,
  stopMeetingNote,
} from "../../actions/note.actions";
import { openUpgradePlanDialog } from "../../actions/pricing.actions";
import { useAsyncEffect } from "../../hooks/async.hooks";
import { getNotePath, useNoteTranscriptCopyText } from "../../hooks/note.hooks";
import type { NoteView } from "../../state/notes.state";
import { produceAppState, useAppStore } from "../../store";
import { DICTATION_WORDS_EXCEEDED_ERROR_CODE } from "../../pipelines/local-note.pipeline";
import { getNoteResumeBlocker } from "../../utils/note-audio.utils";
import { describeNoteError } from "../../utils/note-error.utils";
import {
  formatNoteDuration,
  getNoteElapsedMs,
  getNoteGenerationAvailableFor,
  getCloudNotesUserId,
  getLocalNoteProcessedWith,
  getLocalNoteTranscribesWithVoquill,
  getNoteHasTranscript,
} from "../../utils/note.utils";
import { getProviderFormConfig } from "../settings/api-key-provider-config";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { EditTypography } from "../common/EditTypography";
import { SegmentedControl } from "../common/SegmentedControl";
import { DeleteNoteDialog } from "./DeleteNoteDialog";
import { RecordingDot } from "./MeetingIndicatorChip";
import { NOTE_CONTENT_MIN_HEIGHT, NoteAskDock } from "./NoteAskDock";
import { NoteMarkdown } from "./NoteMarkdown";
import { NoteTranscript } from "./NoteTranscript";
import { PersonalNotesEditor } from "./PersonalNotesEditor";

const NOTES_PATH = "/dashboard/notes";

const openPostProcessingSettings = () => {
  produceAppState((draft) => {
    draft.settings.aiPostProcessingDialogOpen = true;
  });
};

const panelSx = {
  border: 1,
  borderColor: "divider",
  borderRadius: 1,
  bgcolor: "level1",
  p: 2,
} as const;

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

/** Mirrors resumeMeetingNote's check, so Resume is only offered when it can work. */
const useCanResumeNote = (noteId: string) =>
  useAppStore(
    (state) =>
      getNoteResumeBlocker({
        noteElapsedMs: state.noteById[noteId]?.durationMs ?? 0,
        segments: state.noteSegmentsByNoteId[noteId] ?? [],
      }) === null,
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
    } catch (error) {
      if (error instanceof NoteRecordingBlockedError) {
        const problem = describeNoteError(intl, error.code);
        showErrorSnackbar(`${problem.title}. ${problem.body}`);
        return;
      }
      showErrorSnackbar(
        intl.formatMessage({
          defaultMessage:
            "Couldn't start recording. Check that your microphone is connected and allowed.",
        }),
      );
    }
  };
};

const MetaChip = ({
  icon,
  label,
  color,
  tooltip,
}: {
  icon: ReactElement;
  label: ReactNode;
  color?: "error" | "default";
  tooltip?: ReactNode;
}) => {
  const chip = (
    <Chip
      size="small"
      variant="outlined"
      color={color}
      icon={icon}
      label={label}
      sx={{
        height: 26,
        borderColor: color === "error" ? undefined : "divider",
        color: color === "error" ? undefined : "text.secondary",
        "& .MuiChip-icon": {
          fontSize: 15,
          color: color === "error" ? undefined : "text.secondary",
        },
        "& .MuiChip-label": { fontVariantNumeric: "tabular-nums" },
      }}
      tabIndex={tooltip ? 0 : undefined}
    />
  );
  return tooltip ? <Tooltip title={tooltip}>{chip}</Tooltip> : chip;
};

const useProcessorName = () => {
  const intl = useIntl();
  return (processor: NoteProcessor): string => {
    switch (processor.kind) {
      case "voquill":
        return intl.formatMessage({ defaultMessage: "Voquill Cloud" });
      case "device":
        return intl.formatMessage({ defaultMessage: "Whisper on this device" });
      case "api": {
        const provider = processor.provider as ApiKeyProvider;
        const name = API_KEY_PROVIDERS.includes(provider)
          ? getProviderFormConfig(provider, "post-processing").displayName
          : processor.provider;
        return intl.formatMessage(
          { defaultMessage: "{provider} (your API key)" },
          { provider: name },
        );
      }
    }
  };
};

/**
 * Where the note lives and who produced it. A local note is "On this
 * device" only when nothing left the device; otherwise the tooltip names
 * each service (recorded when the note was processed, else the current
 * settings it will use).
 */
const NoteStorageChip = ({ note }: { note: Note }) => {
  const processorName = useProcessorName();
  const current = useAppStore((state) =>
    note.storage === "local" && !note.processedWith
      ? getLocalNoteProcessedWith(state)
      : null,
  );
  if (note.storage === "cloud") {
    return (
      <MetaChip
        icon={<CloudOutlined />}
        label={<FormattedMessage defaultMessage="Voquill Cloud" />}
        tooltip={
          <FormattedMessage defaultMessage="Stored in your Voquill account. Transcribed and written by Voquill." />
        }
      />
    );
  }
  const routes = note.processedWith ?? current!;
  const transcription =
    note.source === "recording" ? routes.transcription : null;
  const allOnDevice =
    (!transcription || transcription.kind === "device") && !routes.notes;
  const pending = !note.processedWith;
  return (
    <MetaChip
      icon={<LaptopOutlined />}
      label={
        allOnDevice ? (
          <FormattedMessage defaultMessage="On this device" />
        ) : (
          <FormattedMessage defaultMessage="Stored on this device" />
        )
      }
      tooltip={
        <Stack component="span">
          <FormattedMessage defaultMessage="The note is stored on this device." />
          {transcription &&
            (pending ? (
              <FormattedMessage
                defaultMessage="Will be transcribed with {service}."
                values={{ service: processorName(transcription) }}
              />
            ) : (
              <FormattedMessage
                defaultMessage="Transcribed with {service}."
                values={{ service: processorName(transcription) }}
              />
            ))}
          {routes.notes ? (
            pending ? (
              <FormattedMessage
                defaultMessage="AI notes will be written with {service}."
                values={{ service: processorName(routes.notes) }}
              />
            ) : (
              <FormattedMessage
                defaultMessage="AI notes written with {service}."
                values={{ service: processorName(routes.notes) }}
              />
            )
          ) : (
            <FormattedMessage defaultMessage="No AI notes (post-processing is off)." />
          )}
        </Stack>
      }
    />
  );
};

const NoteStateChip = ({ note }: { note: Note }) => {
  const isCapturing = useAppStore(
    (state) => state.notes.capture?.noteId === note.id,
  );
  const activityKind = useAppStore(
    (state) => state.notes.cloudActivityByNoteId[note.id]?.kind ?? null,
  );
  const hasFailedPart = useAppStore((state) =>
    (state.noteSegmentsByNoteId[note.id] ?? []).some(
      (segment) => segment.status === "failed",
    ),
  );

  switch (note.status) {
    case "recording":
    case "paused":
      return isCapturing ? (
        <MetaChip
          color="error"
          icon={<MicRounded />}
          label={<FormattedMessage defaultMessage="Recording" />}
        />
      ) : (
        <MetaChip
          icon={<PauseRounded />}
          label={<FormattedMessage defaultMessage="Paused" />}
        />
      );
    case "pending":
    case "processing":
      if (activityKind === "waiting-for-connection") {
        return (
          <MetaChip
            icon={<CloudOffOutlined />}
            label={<FormattedMessage defaultMessage="Waiting for connection" />}
          />
        );
      }
      if (activityKind === "server-busy") {
        return (
          <MetaChip
            icon={<HourglassEmptyRounded />}
            label={<FormattedMessage defaultMessage="Queued" />}
          />
        );
      }
      return (
        <MetaChip
          icon={<CircularProgress size={12} color="inherit" />}
          label={
            activityKind === "uploading" ? (
              <FormattedMessage defaultMessage="Uploading" />
            ) : (
              <FormattedMessage defaultMessage="Processing" />
            )
          }
        />
      );
    case "failed":
      return (
        <MetaChip
          color="error"
          icon={<ErrorOutlineRounded />}
          label={<FormattedMessage defaultMessage="Didn't finish" />}
        />
      );
    case "ready":
      return hasFailedPart ? (
        <MetaChip
          color="error"
          icon={<ErrorOutlineRounded />}
          label={<FormattedMessage defaultMessage="Part not transcribed" />}
        />
      ) : null;
  }
};

const NoteMetaChips = ({ note }: { note: Note }) => {
  const intl = useIntl();
  const isActive = note.status === "recording" || note.status === "paused";
  return (
    <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
      <MetaChip
        icon={<CalendarTodayOutlined />}
        label={`${intl.formatDate(note.createdAt, {
          weekday: "short",
          month: "short",
          day: "numeric",
        })}, ${intl.formatTime(note.createdAt, { timeStyle: "short" })}`}
      />
      {note.source === "import" ? (
        <MetaChip
          icon={<FileUploadOutlined />}
          label={<FormattedMessage defaultMessage="Imported" />}
        />
      ) : (
        !isActive &&
        note.durationMs > 0 && (
          <MetaChip
            icon={<ScheduleOutlined />}
            label={formatNoteDuration(note.durationMs)}
          />
        )
      )}
      <NoteStateChip note={note} />
      <NoteStorageChip note={note} />
    </Stack>
  );
};

const NoteProblem = ({
  error,
  hasAudio,
  onRetry,
  action,
  severity = "error",
}: {
  error: NoteError | string | null | undefined;
  hasAudio: boolean;
  onRetry?: () => void;
  action?: ReactNode;
  severity?: "error" | "warning";
}) => {
  const intl = useIntl();
  const description = describeNoteError(intl, error);
  const showRetry = Boolean(onRetry) && description.retryable;
  const hasActions = description.upgrade || showRetry || Boolean(action);
  return (
    <Alert severity={severity}>
      <AlertTitle>{description.title}</AlertTitle>
      {description.body}{" "}
      {description.availableAt && (
        <>
          <FormattedMessage
            defaultMessage="Available again {when}."
            values={{
              when: intl.formatDate(description.availableAt, {
                dateStyle: "medium",
                timeStyle: "short",
              }),
            }}
          />{" "}
        </>
      )}
      {hasAudio && description.audioSafe && (
        <FormattedMessage defaultMessage="Your recording is safe on this device." />
      )}
      {hasActions && (
        <Stack direction="row" spacing={1} sx={{ mt: 1, ml: -0.75 }}>
          {showRetry && (
            <Button color="inherit" size="small" onClick={onRetry}>
              <FormattedMessage defaultMessage="Retry" />
            </Button>
          )}
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
      )}
    </Alert>
  );
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
  const canResume = useCanResumeNote(note.id);
  const silent = useAppStore(
    (state) =>
      state.notes.capture?.noteId === note.id && state.notes.capture.silent,
  );

  return (
    <Stack spacing={1.5}>
      {note.error && !isCapturing && (
        <NoteProblem severity="warning" error={note.error} hasAudio />
      )}
      {silent && (
        <Alert severity="warning" role="status">
          <AlertTitle>
            <FormattedMessage defaultMessage="No sound is reaching Voquill" />
          </AlertTitle>
          <FormattedMessage defaultMessage="Check that the right microphone is selected in Settings and that Voquill is allowed to use it. Recording continues." />
        </Alert>
      )}
      <Stack
        direction="row"
        alignItems="center"
        spacing={2}
        sx={panelSx}
        role="group"
        aria-label={intl.formatMessage({ defaultMessage: "Recording" })}
      >
        <Stack sx={{ flex: 1, minWidth: 0 }} spacing={0.5}>
          <Stack direction="row" alignItems="center" spacing={1.25}>
            {isCapturing ? (
              <RecordingDot size={10} />
            ) : (
              <PauseRounded sx={{ fontSize: 16, color: "text.secondary" }} />
            )}
            <Typography
              variant="h5"
              fontWeight={600}
              sx={{ fontVariantNumeric: "tabular-nums" }}
              aria-live="off"
            >
              {elapsed}
            </Typography>
            {isCapturing && (
              <LinearProgress
                variant="determinate"
                value={Math.min(100, level * 400)}
                aria-label={intl.formatMessage({
                  defaultMessage: "Input level",
                })}
                sx={{
                  width: 56,
                  height: 4,
                  borderRadius: 2,
                  "& .MuiLinearProgress-bar": { transition: "none" },
                }}
              />
            )}
          </Stack>
          <Typography variant="body2" color="text.secondary">
            {isCapturing ? (
              <FormattedMessage defaultMessage="Keeps recording if you leave this page." />
            ) : canResume ? (
              <FormattedMessage defaultMessage="Paused. Resume to add to this note." />
            ) : (
              <FormattedMessage defaultMessage="Paused. Stop to write the notes." />
            )}
          </Typography>
        </Stack>
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
          canResume && (
            <Button
              variant="outlined"
              size="large"
              startIcon={<MicRounded />}
              onClick={() => resumeNote(note.id)}
            >
              <FormattedMessage defaultMessage="Resume" />
            </Button>
          )
        )}
        <Button
          variant="contained"
          color="error"
          size="large"
          startIcon={<StopRounded />}
          onClick={() => stopMeetingNote(note.id).catch(showErrorSnackbar)}
          sx={{ px: 3 }}
        >
          {isCapturing ? (
            <FormattedMessage defaultMessage="Stop" />
          ) : (
            <FormattedMessage defaultMessage="Finish" />
          )}
        </Button>
      </Stack>
    </Stack>
  );
};

type ProgressView = {
  label: ReactNode;
  /** Null shows ongoing work without a known amount. */
  percent: number | null;
  /** Waiting (offline, queued) rather than working: no progress bar. */
  waiting?: boolean;
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
    <FormattedMessage defaultMessage="You can leave this page. The notes appear here when they're ready." />
  );

  if (note.storage === "cloud") {
    if (activity?.kind === "uploading") {
      return {
        label: <FormattedMessage defaultMessage="Uploading the recording" />,
        percent:
          activity.totalBytes > 0
            ? Math.round((activity.uploadedBytes / activity.totalBytes) * 100)
            : 0,
        hint: leaveHint,
      };
    }
    if (activity?.kind === "waiting-for-connection") {
      return {
        label: <FormattedMessage defaultMessage="Waiting for a connection" />,
        percent: null,
        waiting: true,
        hint: (
          <FormattedMessage defaultMessage="Your recording is safe on this device. It uploads as soon as you're back online." />
        ),
      };
    }
    if (activity?.kind === "server-busy") {
      return {
        label: <FormattedMessage defaultMessage="Queued" />,
        percent: null,
        waiting: true,
        hint: (
          <FormattedMessage defaultMessage="Your other meetings are still processing. This one starts when one finishes." />
        ),
      };
    }
    return {
      label:
        note.status === "pending" ? (
          <FormattedMessage defaultMessage="Getting ready to upload" />
        ) : (
          <FormattedMessage defaultMessage="Transcribing and writing notes" />
        ),
      percent: null,
      hint: leaveHint,
    };
  }

  return local.transcribing
    ? {
        label: <FormattedMessage defaultMessage="Transcribing" />,
        percent: local.percent,
        hint: leaveHint,
      }
    : {
        label: <FormattedMessage defaultMessage="Writing notes" />,
        percent: null,
        hint: leaveHint,
      };
};

const ProcessingPanel = ({ note }: { note: Note }) => {
  const progress = useProcessingProgress(note);
  return (
    <Stack spacing={1} sx={panelSx} role="status">
      <Stack direction="row" alignItems="baseline" spacing={1}>
        <Typography variant="subtitle2" fontWeight={600} sx={{ flex: 1 }}>
          {progress.label}
        </Typography>
        {progress.percent !== null && (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ fontVariantNumeric: "tabular-nums" }}
          >
            {progress.percent}%
          </Typography>
        )}
      </Stack>
      {!progress.waiting && (
        <LinearProgress
          variant={progress.percent === null ? "indeterminate" : "determinate"}
          value={progress.percent ?? 0}
          sx={{ height: 4, borderRadius: 2 }}
        />
      )}
      <Typography variant="body2" color="text.secondary">
        {progress.hint}
      </Typography>
    </Stack>
  );
};

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
          error={segment.audioPath ? segment.error : "audio_missing"}
          hasAudio={Boolean(segment.audioPath)}
          onRetry={
            segment.audioPath
              ? () =>
                  retryNoteSegment(note.id, segment.id).catch(showErrorSnackbar)
              : undefined
          }
          action={
            <Button
              color="inherit"
              size="small"
              onClick={() => setDropSegmentId(segment.id)}
            >
              <FormattedMessage defaultMessage="Remove part" />
            </Button>
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

const AiNotesView = ({ note }: { note: Note }) => {
  const hasTranscript = useAppStore((state) =>
    getNoteHasTranscript(state, note.id),
  );
  const generationAvailable = useAppStore((state) =>
    getNoteGenerationAvailableFor(state, note.id),
  );
  const segmentsLoaded = useAppStore(
    (state) => note.id in state.noteSegmentsByNoteId,
  );
  const showTranscript = () => setNoteView("transcript");

  if (note.generatedNotes) {
    return <NoteMarkdown>{note.generatedNotes}</NoteMarkdown>;
  }
  if (!segmentsLoaded) {
    return null;
  }
  return (
    <Typography variant="body2" color="text.secondary">
      {!hasTranscript ? (
        <FormattedMessage defaultMessage="No speech was detected, so there is nothing to summarize." />
      ) : note.status !== "ready" ? (
        <>
          <FormattedMessage defaultMessage="The AI notes weren't written. The transcript is ready." />{" "}
          <Link component="button" onClick={showTranscript}>
            <FormattedMessage defaultMessage="Show transcript" />
          </Link>
        </>
      ) : generationAvailable ? (
        <FormattedMessage defaultMessage="This note has no AI notes yet. Use Regenerate to write them from the transcript." />
      ) : (
        <>
          <FormattedMessage defaultMessage="AI notes need post-processing, which is turned off. The transcript is ready." />{" "}
          <Link component="button" onClick={openPostProcessingSettings}>
            <FormattedMessage defaultMessage="Turn it on" />
          </Link>
          {" · "}
          <Link component="button" onClick={showTranscript}>
            <FormattedMessage defaultMessage="Show transcript" />
          </Link>
        </>
      )}
    </Typography>
  );
};

const NoteViews = ({
  note,
  scrollParent,
}: {
  note: Note;
  scrollParent: HTMLElement | null;
}) => {
  const intl = useIntl();
  const view = useAppStore((state) => state.notes.noteView);
  const hasTranscript = useAppStore((state) =>
    getNoteHasTranscript(state, note.id),
  );
  const getTranscriptCopyText = useNoteTranscriptCopyText(note.id);

  const copy = async (text: string, message: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showSnackbar(message, { mode: "success" });
    } catch (error) {
      showErrorSnackbar(error);
    }
  };

  const copyAction =
    view === "notes" && note.generatedNotes
      ? {
          label: intl.formatMessage({ defaultMessage: "Copy notes" }),
          run: () =>
            copy(
              note.generatedNotes ?? "",
              intl.formatMessage({ defaultMessage: "Notes copied" }),
            ),
        }
      : view === "transcript" && hasTranscript
        ? {
            label: intl.formatMessage({ defaultMessage: "Copy transcript" }),
            run: () =>
              copy(
                getTranscriptCopyText(),
                intl.formatMessage({ defaultMessage: "Transcript copied" }),
              ),
          }
        : null;

  const options: { value: NoteView; label: string }[] = [
    {
      value: "notes",
      label: intl.formatMessage({ defaultMessage: "AI notes" }),
    },
    {
      value: "mine",
      label: intl.formatMessage({ defaultMessage: "My notes" }),
    },
    {
      value: "transcript",
      label: intl.formatMessage({ defaultMessage: "Transcript" }),
    },
  ];

  return (
    <Stack spacing={2.5}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <SegmentedControl<NoteView>
            value={view}
            options={options}
            onChange={setNoteView}
            ariaLabel={intl.formatMessage({ defaultMessage: "Note view" })}
          />
        </Box>
        {copyAction && (
          <Button
            variant="text"
            size="small"
            startIcon={<ContentCopyRounded fontSize="small" />}
            onClick={copyAction.run}
            sx={{ flexShrink: 0, color: "text.secondary" }}
          >
            {copyAction.label}
          </Button>
        )}
      </Stack>
      <Box
        role="region"
        aria-label={options.find((o) => o.value === view)?.label}
      >
        {view === "notes" && <AiNotesView note={note} />}
        {view === "mine" && (
          <PersonalNotesEditor noteId={note.id} minRows={12} />
        )}
        {view === "transcript" && (
          <NoteTranscript noteId={note.id} scrollParent={scrollParent} />
        )}
      </Box>
    </Stack>
  );
};

/** For a local note out of Voquill dictation words: process it as a cloud note instead. */
const UseVoquillCloudAction = ({ note }: { note: Note }) => {
  const available = useAppStore(
    (state) =>
      Boolean(getCloudNotesUserId(state)) &&
      getLocalNoteTranscribesWithVoquill(state),
  );
  if (
    note.storage !== "local" ||
    note.error?.code !== DICTATION_WORDS_EXCEEDED_ERROR_CODE ||
    !available
  ) {
    return null;
  }
  return (
    <Button
      color="inherit"
      size="small"
      onClick={() =>
        processNoteInVoquillCloud(note.id).catch(showErrorSnackbar)
      }
    >
      <FormattedMessage defaultMessage="Switch post-processing to Voquill cloud" />
    </Button>
  );
};

const MyNotesSection = ({ noteId }: { noteId: string }) => (
  <Stack spacing={1}>
    <Typography variant="subtitle2" color="text.secondary">
      <FormattedMessage defaultMessage="My notes" />
    </Typography>
    <PersonalNotesEditor noteId={noteId} />
  </Stack>
);

export default function NotePage() {
  const intl = useIntl();
  const navigate = useNavigate();
  const { noteId = "" } = useParams();
  const note = useAppStore((state) => state.noteById[noteId]);
  const loaded = useAppStore((state) => state.notes.loaded);
  const generationAvailable = useAppStore((state) =>
    getNoteGenerationAvailableFor(state, noteId),
  );
  const hasTranscript = useAppStore((state) =>
    getNoteHasTranscript(state, noteId),
  );
  const resumeNote = useResumeNote();
  const canResume = useCanResumeNote(noteId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);

  useAsyncEffect(async () => {
    if (note) {
      await loadNoteSegments(noteId).catch(showErrorSnackbar);
    }
  }, [noteId, Boolean(note)]);

  useEffect(() => {
    setOpenNote(noteId);
    return () => setOpenNote(null);
  }, [noteId]);

  const goBack = () => navigate(NOTES_PATH);
  const backLabel = intl.formatMessage({ defaultMessage: "Back to notes" });

  if (!note) {
    return (
      <Container maxWidth="sm" sx={{ pt: 1 }}>
        <Button
          startIcon={<ArrowBackRounded />}
          onClick={goBack}
          sx={{ ml: -1 }}
        >
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
  const showViews =
    isReady ||
    (note.status === "failed" && (hasTranscript || !!note.generatedNotes));

  return (
    <Box
      sx={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}
    >
      <Box
        ref={setScroller}
        sx={{
          flex: 1,
          minHeight: NOTE_CONTENT_MIN_HEIGHT,
          overflowY: "auto",
          pr: 2,
          overscrollBehavior: "contain",
        }}
      >
        <Container key={note.id} maxWidth="sm" sx={{ pt: 1, pb: 4 }}>
          <Stack
            direction="row"
            alignItems="center"
            spacing={0.5}
            sx={{ mb: 1 }}
          >
            <Tooltip title={backLabel}>
              <IconButton
                onClick={goBack}
                aria-label={backLabel}
                sx={{ ml: -1 }}
              >
                <ArrowBackRounded />
              </IconButton>
            </Tooltip>
            <Box sx={{ flex: 1 }} />
            {isReady && note.source === "recording" && canResume && (
              <IconAction
                label={intl.formatMessage({
                  defaultMessage: "Resume recording",
                })}
                onClick={() => resumeNote(note.id)}
              >
                <MicRounded />
              </IconAction>
            )}
            {isReady && (
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
                  const refusal = await regenerateNote(note.id);
                  if (refusal) {
                    const problem = describeNoteError(intl, refusal);
                    showSnackbar(`${problem.title}. ${problem.body}`);
                  }
                }}
                disabled={!generationAvailable || !hasTranscript}
              >
                <AutorenewRounded />
              </IconAction>
            )}
            <IconAction
              label={intl.formatMessage({ defaultMessage: "Delete note" })}
              onClick={() => setConfirmDelete(true)}
            >
              <DeleteOutlineRounded />
            </IconAction>
          </Stack>

          <EditTypography
            value={note.title}
            onChange={(next) => renameNote(note.id, String(next))}
            validate={(next) => String(next).trim().length > 0}
            typographyProps={{
              variant: "h4",
              fontWeight: 700,
              sx: { overflowWrap: "anywhere" },
              "aria-label": intl.formatMessage({
                defaultMessage: "Note title, press Enter to rename",
              }),
            }}
            textFieldProps={{
              fullWidth: true,
              sx: { width: "100%" },
              slotProps: {
                htmlInput: {
                  "aria-label": intl.formatMessage({
                    defaultMessage: "Note title",
                  }),
                  style: { fontSize: "2.125rem", fontWeight: 700 },
                },
              },
            }}
          />

          <Box sx={{ mt: 1.5, mb: 3 }}>
            <NoteMetaChips note={note} />
          </Box>

          <Stack spacing={3}>
            {isActive && <RecordingPanel note={note} />}
            {isProcessing && <ProcessingPanel note={note} />}
            {note.status === "failed" && (
              <NoteProblem
                error={note.error}
                hasAudio={note.source === "recording"}
                onRetry={() => retryNote(note.id).catch(showErrorSnackbar)}
                action={<UseVoquillCloudAction note={note} />}
              />
            )}
            {isReady && note.error?.code === RECOVERED_AUDIO_ERROR_CODE && (
              <NoteProblem
                severity="warning"
                error={note.error}
                hasAudio
                onRetry={() => retryNote(note.id).catch(showErrorSnackbar)}
              />
            )}
            {isReady && <FailedSegments note={note} />}
            {showViews ? (
              <NoteViews note={note} scrollParent={scroller} />
            ) : (
              <MyNotesSection noteId={note.id} />
            )}
          </Stack>
        </Container>
      </Box>

      <NoteAskDock noteId={note.id} />

      <DeleteNoteDialog
        noteId={confirmDelete ? note.id : null}
        onClose={() => setConfirmDelete(false)}
        onDeleted={goBack}
      />
    </Box>
  );
}
