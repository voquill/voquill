import CloseRounded from "@mui/icons-material/CloseRounded";
import SendRounded from "@mui/icons-material/SendRounded";
import {
  Alert,
  Box,
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  InputBase,
  Link,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import { askNotes, closeNotesAsk } from "../../actions/note.actions";
import { openUpgradePlanDialog } from "../../actions/pricing.actions";
import { getNotePath } from "../../hooks/note.hooks";
import type { NoteAskMessage } from "../../state/notes.state";
import { produceAppState, useAppStore } from "../../store";
import { getNoteAskAvailability } from "../../utils/note.utils";
import { NoteMarkdown } from "./NoteMarkdown";

const openPostProcessingSettings = () => {
  produceAppState((draft) => {
    draft.settings.aiPostProcessingDialogOpen = true;
  });
};

const AskError = ({ code, partial }: { code: string; partial: boolean }) => {
  const text = (() => {
    switch (code) {
      case "post_processing_disabled":
        return (
          <FormattedMessage defaultMessage="Ask needs AI post-processing, which is turned off." />
        );
      case "transcript_unavailable":
        return (
          <FormattedMessage defaultMessage="Ask becomes available once the meeting is processed." />
        );
      case "word_quota_exceeded":
        return (
          <>
            <FormattedMessage defaultMessage="You're out of free words. Upgrade to Pro to keep asking." />{" "}
            <Link component="button" onClick={openUpgradePlanDialog}>
              <FormattedMessage defaultMessage="Upgrade" />
            </Link>
          </>
        );
      case "network_unavailable":
        return (
          <FormattedMessage defaultMessage="You're offline. Ask about your Voquill cloud notes once you're back online." />
        );
      case "signed_out":
        return (
          <FormattedMessage defaultMessage="Sign in to Voquill to ask about your cloud notes." />
        );
      case "ask_incomplete":
      case "ask_failed":
        return partial ? (
          <FormattedMessage defaultMessage="The answer was cut off. Ask again to retry." />
        ) : (
          <FormattedMessage defaultMessage="The answer couldn't be generated. Ask again to retry." />
        );
      default:
        return (
          <FormattedMessage defaultMessage="The answer couldn't be generated. Ask again to retry." />
        );
    }
  })();
  return (
    <Alert severity={partial ? "warning" : "error"} variant="outlined">
      {text}
    </Alert>
  );
};

const AskAnswer = ({ message }: { message: NoteAskMessage }) => {
  const navigate = useNavigate();
  const sourcesOnly = message.streaming && !message.content;

  return (
    <Stack spacing={1}>
      {message.content ? (
        <NoteMarkdown sx={{ typography: "body2" }}>
          {message.content}
        </NoteMarkdown>
      ) : (
        sourcesOnly && (
          <Typography variant="body2" color="text.secondary">
            <FormattedMessage defaultMessage="Reading your notes…" />
          </Typography>
        )
      )}
      {message.error && (
        <AskError code={message.error} partial={!!message.content} />
      )}
      {message.sources.length > 0 && (
        <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
          {message.sources.map((source, index) => (
            <Chip
              key={source.noteId}
              size="small"
              variant="outlined"
              clickable
              label={`${index + 1}. ${source.title}`}
              onClick={() => {
                closeNotesAsk();
                navigate(getNotePath(source.noteId));
              }}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
};

export const AskNotesDialog = () => {
  const intl = useIntl();
  const open = useAppStore((state) => state.notes.askDialogOpen);
  const noteId = useAppStore((state) => state.notes.askNoteId);
  const noteTitle = useAppStore((state) =>
    noteId ? state.noteById[noteId]?.title : null,
  );
  const messages = useAppStore((state) => state.notes.askMessages);
  const availability = useAppStore((state) =>
    getNoteAskAvailability(state, noteId),
  );
  const streaming = messages.some((message) => message.streaming);
  const [question, setQuestion] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const handleSend = () => {
    const text = question.trim();
    if (!text || streaming) return;
    setQuestion("");
    void askNotes(text);
  };

  return (
    <Dialog open={open} onClose={closeNotesAsk} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pr: 7 }}>
        {noteTitle ? (
          <FormattedMessage
            defaultMessage="Ask about “{title}”"
            values={{ title: noteTitle }}
          />
        ) : (
          <FormattedMessage defaultMessage="Ask your notes" />
        )}
        <IconButton
          onClick={closeNotesAsk}
          aria-label={intl.formatMessage({ defaultMessage: "Close" })}
          sx={{ position: "absolute", right: 12, top: 12 }}
        >
          <CloseRounded />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ minHeight: 240 }}>
        {availability === "post-processing-disabled" ? (
          <Typography variant="body2" color="text.secondary">
            <FormattedMessage defaultMessage="Ask uses your AI post-processing model, which is turned off." />{" "}
            <Link component="button" onClick={openPostProcessingSettings}>
              <FormattedMessage defaultMessage="Turn it on" />
            </Link>
          </Typography>
        ) : availability === "no-transcript" ? (
          <Typography variant="body2" color="text.secondary">
            {noteId ? (
              <FormattedMessage defaultMessage="Ask becomes available once this meeting has been processed." />
            ) : (
              <FormattedMessage defaultMessage="Ask becomes available once you have a processed note." />
            )}
          </Typography>
        ) : messages.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {noteId ? (
              <FormattedMessage defaultMessage="Ask anything about this meeting, like what was decided or who owns a follow-up." />
            ) : (
              <FormattedMessage defaultMessage="Ask a question across all your notes. Answers cite the notes they come from." />
            )}
          </Typography>
        ) : (
          <Stack spacing={2.5}>
            {messages.map((message) =>
              message.role === "user" ? (
                <Box
                  key={message.id}
                  sx={{
                    alignSelf: "flex-end",
                    maxWidth: "80%",
                    px: 1.5,
                    py: 1,
                    borderRadius: 1,
                    bgcolor: "action.hover",
                  }}
                >
                  <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
                    {message.content}
                  </Typography>
                </Box>
              ) : (
                <AskAnswer key={message.id} message={message} />
              ),
            )}
            <div ref={endRef} />
          </Stack>
        )}
      </DialogContent>
      {availability === "available" && (
        <Box sx={{ p: 2 }}>
          <Stack
            direction="row"
            alignItems="center"
            spacing={1}
            sx={{ p: 1, borderRadius: 1, border: 1, borderColor: "divider" }}
          >
            <InputBase
              autoFocus
              fullWidth
              multiline
              maxRows={4}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  handleSend();
                }
              }}
              placeholder={
                messages.length > 0
                  ? intl.formatMessage({ defaultMessage: "Ask a follow-up…" })
                  : intl.formatMessage({ defaultMessage: "Ask a question…" })
              }
              inputProps={{
                "aria-label": intl.formatMessage({
                  defaultMessage: "Question",
                }),
              }}
              sx={{ px: 1 }}
            />
            <Tooltip title={intl.formatMessage({ defaultMessage: "Send" })}>
              <span>
                <IconButton
                  color="primary"
                  size="small"
                  onClick={handleSend}
                  disabled={streaming || !question.trim()}
                  aria-label={intl.formatMessage({ defaultMessage: "Send" })}
                >
                  <SendRounded />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        </Box>
      )}
    </Dialog>
  );
};
