import ArrowUpwardRounded from "@mui/icons-material/ArrowUpwardRounded";
import AutoAwesomeOutlined from "@mui/icons-material/AutoAwesomeOutlined";
import ExpandLessRounded from "@mui/icons-material/ExpandLessRounded";
import ExpandMoreRounded from "@mui/icons-material/ExpandMoreRounded";
import StopRounded from "@mui/icons-material/StopRounded";
import {
  Box,
  Button,
  ButtonBase,
  Chip,
  IconButton,
  InputBase,
  Link,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import {
  askNotes,
  clearNotesAsk,
  getNoteAskThread,
  setNotesAskExpanded,
  stopAskingNotes,
} from "../../actions/note-ask.actions";
import { openUpgradePlanDialog } from "../../actions/pricing.actions";
import { getNotePath } from "../../hooks/note.hooks";
import { NOTE_ASK_LIMITS } from "../../repos/cloud-note.repo";
import type { NoteAskMessage } from "../../state/notes.state";
import { produceAppState, useAppStore } from "../../store";
import { describeNoteError } from "../../utils/note-error.utils";
import {
  getNoteAskAvailability,
  type NoteAskAvailability,
} from "../../utils/note.utils";
import { NoteColumn } from "./NoteLayout";
import { NoteMarkdown } from "./NoteMarkdown";

/** The dock, open or not, never covers more of the page than this. */
const DOCK_MAX_HEIGHT = "65%";

/**
 * Bottom padding the page's content needs so its last lines scroll clear of
 * the collapsed dock (fade, last-question row, input bar and window margin).
 */
export const NOTE_ASK_DOCK_CLEARANCE = 136;

/** Lets the thread give up height when the window is short. */
const shrinkColumn = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  flexShrink: 1,
} as const;

/** Send and stop: a small filled circle at the end of the input row. */
const roundActionSx = {
  width: 32,
  height: 32,
  bgcolor: "level3",
  color: "text.primary",
  "&:hover": { bgcolor: "level3", opacity: 0.85 },
  "&.Mui-disabled": { bgcolor: "level2", color: "text.disabled" },
} as const;

const openPostProcessingSettings = () => {
  produceAppState((draft) => {
    draft.settings.aiPostProcessingDialogOpen = true;
  });
};

const AskError = ({
  code,
  details,
  partial,
}: {
  code: string;
  details: Record<string, unknown> | null;
  partial: boolean;
}) => {
  const intl = useIntl();
  const text = (() => {
    switch (code) {
      case "post_processing_disabled":
        return (
          <FormattedMessage defaultMessage="Ask uses AI post-processing, which is turned off." />
        );
      case "transcript_unavailable":
        return (
          <FormattedMessage defaultMessage="You can ask once the meeting is transcribed." />
        );
      case "network_unavailable":
        return (
          <FormattedMessage defaultMessage="Couldn't reach Voquill. Check your connection, then ask again." />
        );
      case "signed_out":
        return (
          <FormattedMessage defaultMessage="Sign in to Voquill to ask about your cloud notes." />
        );
      case "ask_incomplete":
      case "ask_failed":
      case "ask_unavailable":
      case "unknown":
        return partial ? (
          <FormattedMessage defaultMessage="The answer was cut off. Ask again to retry." />
        ) : (
          <FormattedMessage defaultMessage="Couldn't answer that. Ask again to retry." />
        );
      default: {
        const problem = describeNoteError(intl, { code, details });
        return (
          <>
            {problem.title}. {problem.body}{" "}
            {problem.availableAt && (
              <FormattedMessage
                defaultMessage="Available again {when}."
                values={{
                  when: intl.formatDate(problem.availableAt, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }),
                }}
              />
            )}{" "}
            {problem.upgrade && (
              <Link component="button" onClick={openUpgradePlanDialog}>
                <FormattedMessage defaultMessage="Upgrade" />
              </Link>
            )}
          </>
        );
      }
    }
  })();
  return (
    <Typography
      variant="body2"
      color={partial ? "text.secondary" : "error"}
      role="alert"
    >
      {text}
    </Typography>
  );
};

const AskAnswer = ({
  message,
  showSources,
}: {
  message: NoteAskMessage;
  showSources: boolean;
}) => {
  const navigate = useNavigate();
  const thinking = message.streaming && !message.content;

  return (
    <Stack spacing={1} aria-busy={message.streaming}>
      {thinking ? (
        <Typography variant="body2" color="text.secondary">
          <FormattedMessage defaultMessage="Reading your notes…" />
        </Typography>
      ) : (
        message.content && (
          <NoteMarkdown sx={{ typography: "body2" }}>
            {message.content}
          </NoteMarkdown>
        )
      )}
      {message.stopped && (
        <Typography variant="caption" color="text.secondary">
          <FormattedMessage defaultMessage="Stopped" />
        </Typography>
      )}
      {message.error && (
        <AskError
          code={message.error}
          details={message.errorDetails}
          partial={!!message.content}
        />
      )}
      {showSources && message.sources.length > 0 && (
        <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
          {message.sources.map((source, index) => (
            <Chip
              key={source.noteId}
              size="small"
              clickable
              label={`${index + 1}. ${source.title}`}
              onClick={() => navigate(getNotePath(source.noteId))}
              sx={{
                maxWidth: "100%",
                bgcolor: "level2",
                "&:hover": { bgcolor: "level3" },
              }}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
};

const useUnavailableReason = (
  availability: NoteAskAvailability,
  noteId: string | null,
): ReactNode => {
  const intl = useIntl();
  const isRecording = useAppStore((state) => {
    const status = noteId ? state.noteById[noteId]?.status : null;
    return status === "recording" || status === "paused";
  });
  const resetsAt = useAppStore((state) => state.notes.askLimitResetsAt);

  switch (availability) {
    case "available":
      return null;
    case "post-processing-disabled":
      return (
        <>
          <FormattedMessage defaultMessage="Ask uses AI post-processing, which is turned off." />{" "}
          <Link component="button" onClick={openPostProcessingSettings}>
            <FormattedMessage defaultMessage="Turn it on" />
          </Link>
        </>
      );
    case "offline":
      return (
        <FormattedMessage defaultMessage="You're offline. Ask works again when you reconnect." />
      );
    case "limit-reached":
      return (
        <FormattedMessage
          defaultMessage="You've reached today's Ask limit. It resets {when}."
          values={{
            when: resetsAt
              ? intl.formatDate(resetsAt, {
                  weekday: "short",
                  hour: "numeric",
                  minute: "2-digit",
                })
              : "",
          }}
        />
      );
    case "no-transcript":
      return isRecording ? (
        <FormattedMessage defaultMessage="You can ask once you stop recording and the meeting is transcribed." />
      ) : noteId ? (
        <FormattedMessage defaultMessage="You can ask once this meeting is transcribed." />
      ) : (
        <FormattedMessage defaultMessage="You can ask once you have a finished note." />
      );
  }
};

/**
 * Ask, floating over the bottom of a note (noteId) or the notes list (null).
 * The parent must be positioned. Opening the thread never moves the page
 * under it; the thread scrolls on its own within the dock's maximum height.
 */
export const NoteAskDock = ({ noteId }: { noteId: string | null }) => {
  const intl = useIntl();
  const thread = useAppStore((state) => getNoteAskThread(state, noteId));
  const availability = useAppStore((state) =>
    getNoteAskAvailability(state, noteId),
  );
  const unavailableReason = useUnavailableReason(availability, noteId);
  const [question, setQuestion] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);

  const messages = thread?.messages ?? [];
  const expanded = (thread?.expanded ?? false) && messages.length > 0;
  const streaming = messages.some((message) => message.streaming);
  const disabled = availability !== "available";
  const lastQuestion = [...messages]
    .reverse()
    .find((message) => message.role === "user")?.content;

  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller && pinnedToBottomRef.current) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [messages, expanded]);

  const handleScroll = () => {
    const scroller = scrollRef.current;
    if (scroller) {
      pinnedToBottomRef.current =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
    }
  };

  const handleSend = () => {
    const text = question.trim();
    if (!text || streaming || disabled) return;
    setQuestion("");
    pinnedToBottomRef.current = true;
    void askNotes(noteId, text);
  };

  const expand = () => {
    setNotesAskExpanded(noteId, true);
    inputRef.current?.focus();
  };

  const placeholder = noteId
    ? intl.formatMessage({ defaultMessage: "Ask anything about this meeting" })
    : intl.formatMessage({ defaultMessage: "Ask anything across your notes" });
  const sendLabel = intl.formatMessage({ defaultMessage: "Ask" });
  const stopLabel = intl.formatMessage({ defaultMessage: "Stop answering" });
  const collapseLabel = intl.formatMessage({ defaultMessage: "Hide answers" });

  return (
    <Box
      sx={{
        ...shrinkColumn,
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        maxHeight: DOCK_MAX_HEIGHT,
        pt: 3,
        pb: 2,
        pr: 2,
        pointerEvents: "none",
        background: (theme) =>
          `linear-gradient(to bottom, transparent, ${theme.vars?.palette.level0} ${theme.spacing(3)})`,
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && expanded) {
          event.stopPropagation();
          setNotesAskExpanded(noteId, false);
        }
      }}
    >
      <NoteColumn sx={shrinkColumn}>
        <Box
          sx={{
            ...shrinkColumn,
            bgcolor: "level1",
            borderRadius: 1,
            overflow: "hidden",
            pointerEvents: "auto",
          }}
        >
          {expanded && (
            <>
              <Stack
                direction="row"
                alignItems="center"
                spacing={1}
                sx={{ pl: 2, pr: 1, pt: 1, flexShrink: 0 }}
              >
                <AutoAwesomeOutlined
                  sx={{ fontSize: 18, color: "text.secondary" }}
                />
                <Typography
                  variant="subtitle2"
                  fontWeight={600}
                  color="text.secondary"
                  sx={{ flex: 1 }}
                >
                  <FormattedMessage defaultMessage="Ask" />
                </Typography>
                <Button
                  size="small"
                  color="inherit"
                  onClick={() => {
                    clearNotesAsk(noteId);
                    inputRef.current?.focus();
                  }}
                  sx={{
                    color: "text.secondary",
                    minWidth: 0,
                    px: 1.25,
                    py: 0.5,
                    typography: "body2",
                    fontWeight: 500,
                    "&:hover": { bgcolor: "action.hover" },
                  }}
                >
                  <FormattedMessage defaultMessage="Clear" />
                </Button>
                <Tooltip title={`${collapseLabel} (Esc)`}>
                  <IconButton
                    size="small"
                    onClick={() => setNotesAskExpanded(noteId, false)}
                    aria-label={collapseLabel}
                    aria-expanded
                    sx={{ color: "text.secondary" }}
                  >
                    <ExpandMoreRounded fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
              <Box
                ref={scrollRef}
                onScroll={handleScroll}
                role="log"
                aria-live="polite"
                aria-label={intl.formatMessage({ defaultMessage: "Answers" })}
                sx={{
                  flex: "0 1 auto",
                  minHeight: 0,
                  overflowY: "auto",
                  overscrollBehavior: "contain",
                  px: 2,
                  pt: 1.5,
                  pb: 1,
                }}
              >
                <Stack spacing={2}>
                  {messages.map((message) =>
                    message.role === "user" ? (
                      <Box
                        key={message.id}
                        sx={{
                          alignSelf: "flex-end",
                          maxWidth: "85%",
                          px: 1.5,
                          py: 0.75,
                          borderRadius: 1,
                          bgcolor: "level2",
                        }}
                      >
                        <Typography
                          variant="body2"
                          sx={{
                            whiteSpace: "pre-wrap",
                            overflowWrap: "anywhere",
                          }}
                        >
                          {message.content}
                        </Typography>
                      </Box>
                    ) : (
                      <AskAnswer
                        key={message.id}
                        message={message}
                        showSources={noteId === null}
                      />
                    ),
                  )}
                </Stack>
              </Box>
            </>
          )}
          {!expanded && lastQuestion && (
            <ButtonBase
              onClick={expand}
              aria-expanded={false}
              aria-label={intl.formatMessage({
                defaultMessage: "Show answers",
              })}
              sx={{
                width: "100%",
                flexShrink: 0,
                justifyContent: "flex-start",
                gap: 1,
                pl: 2,
                pr: 2,
                pt: 1.25,
                pb: 0.5,
                color: "text.secondary",
                "&:hover, &.Mui-focusVisible": { color: "text.primary" },
              }}
            >
              <ExpandLessRounded sx={{ fontSize: 18 }} />
              <Typography
                variant="body2"
                noWrap
                sx={{ flex: 1, minWidth: 0, textAlign: "left" }}
              >
                {lastQuestion}
              </Typography>
              {streaming && (
                <Typography variant="caption">
                  <FormattedMessage defaultMessage="Answering…" />
                </Typography>
              )}
            </ButtonBase>
          )}
          <Stack
            direction="row"
            alignItems="flex-end"
            spacing={1}
            sx={{ pl: 2, pr: 1, py: 1, flexShrink: 0 }}
          >
            {disabled ? (
              <Typography
                variant="body2"
                color="text.secondary"
                role="status"
                sx={{ flex: 1, minWidth: 0, py: 0.75 }}
              >
                {unavailableReason}
              </Typography>
            ) : (
              <InputBase
                inputRef={inputRef}
                fullWidth
                multiline
                maxRows={5}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onFocus={() => {
                  if (messages.length > 0) setNotesAskExpanded(noteId, true);
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    handleSend();
                  }
                }}
                placeholder={
                  messages.length > 0
                    ? intl.formatMessage({ defaultMessage: "Ask a follow-up" })
                    : placeholder
                }
                inputProps={{
                  "aria-label": placeholder,
                  maxLength: NOTE_ASK_LIMITS.maxQuestionChars,
                }}
                sx={{ flex: 1, py: 0.75, typography: "body2" }}
              />
            )}
            {streaming ? (
              <Tooltip title={stopLabel}>
                <IconButton
                  onClick={() => stopAskingNotes(noteId)}
                  aria-label={stopLabel}
                  sx={roundActionSx}
                >
                  <StopRounded sx={{ fontSize: 18 }} />
                </IconButton>
              </Tooltip>
            ) : (
              !disabled && (
                <Tooltip title={sendLabel}>
                  <span>
                    <IconButton
                      onClick={handleSend}
                      disabled={!question.trim()}
                      aria-label={sendLabel}
                      sx={[
                        roundActionSx,
                        {
                          bgcolor: "primary.main",
                          color: "primary.contrastText",
                          "&:hover": { bgcolor: "primary.main", opacity: 0.85 },
                        },
                      ]}
                    >
                      <ArrowUpwardRounded sx={{ fontSize: 18 }} />
                    </IconButton>
                  </span>
                </Tooltip>
              )
            )}
          </Stack>
        </Box>
      </NoteColumn>
    </Box>
  );
};
