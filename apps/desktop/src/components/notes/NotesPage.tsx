import AddRounded from "@mui/icons-material/AddRounded";
import FileUploadOutlined from "@mui/icons-material/FileUploadOutlined";
import QuestionAnswerOutlined from "@mui/icons-material/QuestionAnswerOutlined";
import SearchRounded from "@mui/icons-material/SearchRounded";
import StickyNote2Outlined from "@mui/icons-material/StickyNote2Outlined";
import {
  Box,
  Button,
  Container,
  IconButton,
  InputAdornment,
  List,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { showErrorSnackbar } from "../../actions/app.actions";
import {
  openImportTranscriptDialog,
  openNotesAsk,
  searchNotes,
} from "../../actions/note.actions";
import { syncCloudNotes } from "../../actions/note-sync.actions";
import { useStartMeetingNote } from "../../hooks/note.hooks";
import { useAppStore } from "../../store";
import {
  getNoteGenerationAvailable,
  getSortedNoteIds,
  selectNoteStorage,
} from "../../utils/note.utils";
import {
  extractSearchTerms,
  type NoteSearchResult,
} from "../../utils/note-search.utils";
import { DeleteNoteDialog } from "./DeleteNoteDialog";
import { ImportTranscriptDialog } from "./ImportTranscriptDialog";
import { NoteRow } from "./NoteRow";

const SEARCH_DEBOUNCE_MS = 250;

export default function NotesPage() {
  const intl = useIntl();
  const startMeetingNote = useStartMeetingNote();
  const noteIds = useAppStore(getSortedNoteIds);
  const loaded = useAppStore((state) => state.notes.loaded);
  const generationAvailable = useAppStore(
    (state) =>
      selectNoteStorage(state) === "cloud" || getNoteGenerationAvailable(state),
  );
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NoteSearchResult[] | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const terms = useMemo(() => extractSearchTerms(query), [query]);

  useEffect(() => {
    void syncCloudNotes({ force: true });
  }, []);

  useEffect(() => {
    if (terms.length === 0) {
      setResults(null);
      return;
    }
    let cancelled = false;
    const timeout = setTimeout(() => {
      searchNotes(query)
        .then((found) => {
          if (!cancelled) setResults(found);
        })
        .catch(showErrorSnackbar);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [query, terms.length, noteIds]);

  const importButton = (
    <IconButton
      onClick={openImportTranscriptDialog}
      disabled={!generationAvailable}
      aria-label={intl.formatMessage({ defaultMessage: "Import transcript" })}
    >
      <FileUploadOutlined />
    </IconButton>
  );

  const showingResults = results !== null && terms.length > 0;
  const listedIds = showingResults
    ? results.map((result) => result.note.id)
    : noteIds;
  const snippetById = new Map(
    (results ?? []).map((result) => [result.note.id, result.snippet]),
  );

  return (
    <Box
      sx={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}
    >
      <Container maxWidth="sm" sx={{ pt: 1, pb: 2, flexShrink: 0 }}>
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          spacing={1}
        >
          <Typography variant="h4" fontWeight={700} sx={{ flex: 1 }}>
            <FormattedMessage defaultMessage="Notes" />
          </Typography>
          <Button
            variant="text"
            startIcon={<QuestionAnswerOutlined />}
            onClick={() => openNotesAsk(null)}
          >
            <FormattedMessage defaultMessage="Ask" />
          </Button>
          <Tooltip
            title={
              generationAvailable
                ? intl.formatMessage({ defaultMessage: "Import transcript" })
                : intl.formatMessage({
                    defaultMessage:
                      "Importing a transcript needs AI post-processing, which is turned off in Settings",
                  })
            }
          >
            <span>{importButton}</span>
          </Tooltip>
          <Button
            variant="contained"
            startIcon={<AddRounded />}
            onClick={startMeetingNote}
          >
            <FormattedMessage defaultMessage="New" />
          </Button>
        </Stack>
        {noteIds.length > 0 && (
          <TextField
            fullWidth
            size="small"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={intl.formatMessage({ defaultMessage: "Search notes" })}
            slotProps={{
              htmlInput: {
                "aria-label": intl.formatMessage({
                  defaultMessage: "Search notes",
                }),
              },
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchRounded fontSize="small" />
                  </InputAdornment>
                ),
              },
            }}
            sx={{ mt: 2 }}
          />
        )}
      </Container>

      <Box sx={{ flex: 1, overflowY: "auto", pb: 4 }}>
        <Container maxWidth="sm">
          {loaded && noteIds.length === 0 ? (
            <Stack
              alignItems="center"
              spacing={1}
              sx={{ pt: 10, textAlign: "center", color: "text.secondary" }}
            >
              <StickyNote2Outlined sx={{ fontSize: 40, opacity: 0.6 }} />
              <Typography variant="h6">
                <FormattedMessage defaultMessage="No notes yet" />
              </Typography>
              <Typography variant="body2" sx={{ maxWidth: 380 }}>
                <FormattedMessage defaultMessage="Press New when a meeting starts. Voquill records it and writes the notes for you: a summary, decisions and action items, plus the full transcript." />
              </Typography>
            </Stack>
          ) : showingResults && listedIds.length === 0 ? (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ pt: 4, textAlign: "center" }}
            >
              <FormattedMessage
                defaultMessage="No notes match “{query}”"
                values={{ query: query.trim() }}
              />
            </Typography>
          ) : (
            <List disablePadding>
              {listedIds.map((noteId) => (
                <NoteRow
                  key={noteId}
                  noteId={noteId}
                  snippet={snippetById.get(noteId) ?? null}
                  highlightTerms={showingResults ? terms : []}
                  onDelete={setPendingDeleteId}
                />
              ))}
            </List>
          )}
        </Container>
      </Box>

      <ImportTranscriptDialog />
      <DeleteNoteDialog
        noteId={pendingDeleteId}
        onClose={() => setPendingDeleteId(null)}
      />
    </Box>
  );
}
