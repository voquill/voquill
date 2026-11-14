import AddRounded from "@mui/icons-material/AddRounded";
import CloudOffOutlined from "@mui/icons-material/CloudOffOutlined";
import FileUploadOutlined from "@mui/icons-material/FileUploadOutlined";
import SearchRounded from "@mui/icons-material/SearchRounded";
import StickyNote2Outlined from "@mui/icons-material/StickyNote2Outlined";
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  InputAdornment,
  Link,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { GroupedVirtuoso, Virtuoso } from "react-virtuoso";
import { showErrorSnackbar } from "../../actions/app.actions";
import {
  openImportTranscriptDialog,
  searchNotes,
} from "../../actions/note.actions";
import { syncCloudNotes } from "../../actions/note-sync.actions";
import { useStartMeetingNote } from "../../hooks/note.hooks";
import { useAppStore } from "../../store";
import {
  getNoteList,
  getLocalDayKey,
  groupNotesByDay,
  type NoteDayGroup,
} from "../../utils/note-list.utils";
import {
  getNoteGenerationAvailable,
  selectNoteStorage,
} from "../../utils/note.utils";
import {
  extractSearchTerms,
  type NoteSearchResult,
} from "../../utils/note-search.utils";
import { DeleteNoteDialog } from "./DeleteNoteDialog";
import { ImportTranscriptDialog } from "./ImportTranscriptDialog";
import { NOTE_ASK_DOCK_CLEARANCE, NoteAskDock } from "./NoteAskDock";
import { flatFieldSx, NoteColumn } from "./NoteLayout";
import { NoteRow } from "./NoteRow";

const SEARCH_DEBOUNCE_MS = 350;
const DAY_CHECK_MS = 60_000;

/** Today's date, refreshed when the day changes so the group labels stay right. */
const useToday = (): Date => {
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    const interval = setInterval(() => {
      const now = new Date();
      setToday((current) =>
        getLocalDayKey(current) === getLocalDayKey(now) ? current : now,
      );
    }, DAY_CHECK_MS);
    return () => clearInterval(interval);
  }, []);
  return today;
};

const ListItem = ({ children }: { children: ReactNode }) => (
  <Box sx={{ pr: 2 }}>
    <NoteColumn scope="list">{children}</NoteColumn>
  </Box>
);

const ListFooter = () => <Box sx={{ height: NOTE_ASK_DOCK_CLEARANCE }} />;

const DayHeader = ({ group }: { group: NoteDayGroup }) => {
  const intl = useIntl();
  const label =
    group.kind === "today" ? (
      <FormattedMessage defaultMessage="Today" />
    ) : group.kind === "yesterday" ? (
      <FormattedMessage defaultMessage="Yesterday" />
    ) : (
      intl.formatDate(group.date, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year:
          group.date.getFullYear() === new Date().getFullYear()
            ? undefined
            : "numeric",
      })
    );
  return (
    <Box sx={{ bgcolor: "background.default" }}>
      <ListItem>
        <Typography
          component="h2"
          variant="subtitle2"
          color="text.secondary"
          sx={{ pt: 2, pb: 0.5 }}
        >
          {label}
        </Typography>
      </ListItem>
    </Box>
  );
};

const CenteredMessage = ({ children }: { children: ReactNode }) => (
  <Stack
    alignItems="center"
    justifyContent="center"
    spacing={1}
    sx={{ flex: 1, px: 4, pb: 8, textAlign: "center", color: "text.secondary" }}
  >
    {children}
  </Stack>
);

export default function NotesPage() {
  const intl = useIntl();
  const startMeetingNote = useStartMeetingNote();
  const { activeNoteId, entries } = useAppStore(getNoteList);
  const loaded = useAppStore((state) => state.notes.loaded);
  const isCloud = useAppStore((state) => selectNoteStorage(state) === "cloud");
  const showOffline = useAppStore(
    (state) =>
      !state.notes.online &&
      (selectNoteStorage(state) === "cloud" ||
        Object.values(state.noteById).some((note) => note.storage === "cloud")),
  );
  const generationAvailable = useAppStore(
    (state) => isCloud || getNoteGenerationAvailable(state),
  );
  const today = useToday();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NoteSearchResult[] | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const terms = useMemo(() => extractSearchTerms(query), [query]);
  const groups = useMemo(
    () => groupNotesByDay(entries, today),
    [entries, today],
  );
  const noteCount = entries.length + (activeNoteId ? 1 : 0);
  const groupedIds = useMemo(
    () => groups.flatMap((group) => group.noteIds),
    [groups],
  );

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
  }, [query, terms.length, noteCount]);

  const searching = terms.length > 0;
  const importLabel = generationAvailable
    ? intl.formatMessage({ defaultMessage: "Import transcript" })
    : intl.formatMessage({
        defaultMessage:
          "Importing a transcript needs AI post-processing, which is turned off in Settings",
      });

  const renderRow = (noteId: string, result?: NoteSearchResult) => (
    <ListItem>
      <NoteRow
        noteId={noteId}
        snippet={result?.snippet ?? null}
        highlightTerms={result ? terms : []}
        when={result ? "date" : "time"}
        onDelete={setPendingDeleteId}
      />
    </ListItem>
  );

  const body = (() => {
    if (!loaded) {
      return (
        <CenteredMessage>
          <CircularProgress
            size={24}
            aria-label={intl.formatMessage({ defaultMessage: "Loading notes" })}
          />
        </CenteredMessage>
      );
    }
    if (noteCount === 0) {
      return (
        <CenteredMessage>
          <StickyNote2Outlined sx={{ fontSize: 40, opacity: 0.6 }} />
          <Typography variant="h6" color="text.primary">
            <FormattedMessage defaultMessage="Notes for every meeting" />
          </Typography>
          <Typography variant="body2" sx={{ maxWidth: 400 }}>
            <FormattedMessage defaultMessage="Press New when a meeting starts. Voquill records it and writes a summary, decisions and action items, with the full transcript. Dictation keeps working while you record." />
          </Typography>
          <Stack direction="row" spacing={1} sx={{ pt: 2 }}>
            <Button
              variant="contained"
              startIcon={<AddRounded />}
              onClick={startMeetingNote}
            >
              <FormattedMessage defaultMessage="Start recording" />
            </Button>
            <Button
              variant="text"
              startIcon={<FileUploadOutlined />}
              onClick={openImportTranscriptDialog}
              disabled={!generationAvailable}
            >
              <FormattedMessage defaultMessage="Import a transcript" />
            </Button>
          </Stack>
        </CenteredMessage>
      );
    }
    if (searching) {
      if (results === null) {
        return null;
      }
      if (results.length === 0) {
        return (
          <CenteredMessage>
            <Typography variant="body1" color="text.primary">
              <FormattedMessage
                defaultMessage="No notes match “{query}”"
                values={{ query: query.trim() }}
              />
            </Typography>
            <Typography variant="body2">
              <FormattedMessage defaultMessage="Try other words, or ask a question below." />{" "}
              <Link component="button" onClick={() => setQuery("")}>
                <FormattedMessage defaultMessage="Clear search" />
              </Link>
            </Typography>
          </CenteredMessage>
        );
      }
      return (
        <Virtuoso
          style={{ flex: 1 }}
          data={results}
          computeItemKey={(_, result) => result.note.id}
          itemContent={(_, result) => renderRow(result.note.id, result)}
          components={{ Footer: ListFooter }}
        />
      );
    }
    return (
      <GroupedVirtuoso
        style={{ flex: 1 }}
        groupCounts={groups.map((group) => group.noteIds.length)}
        groupContent={(index) => <DayHeader group={groups[index]} />}
        itemContent={(index) => renderRow(groupedIds[index])}
        components={{ Footer: ListFooter }}
      />
    );
  })();

  return (
    <Box
      sx={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        position: "relative",
      }}
    >
      <Box sx={{ pr: 2, flexShrink: 0 }}>
        <NoteColumn scope="list" sx={{ pt: 1, pb: 1 }}>
          <Stack direction="row" alignItems="flex-start" spacing={1}>
            <Stack sx={{ flex: 1, minWidth: 0 }} spacing={0.5}>
              <Typography variant="h4" fontWeight={700}>
                <FormattedMessage defaultMessage="Notes" />
              </Typography>
              {noteCount > 0 && (
                <Typography variant="subtitle1" color="text.secondary">
                  <FormattedMessage
                    defaultMessage="{count} {count, plural, one {note} other {notes}}"
                    values={{ count: noteCount }}
                  />
                </Typography>
              )}
            </Stack>
            <Tooltip title={importLabel}>
              <span>
                <IconButton
                  onClick={openImportTranscriptDialog}
                  disabled={!generationAvailable}
                  aria-label={importLabel}
                >
                  <FileUploadOutlined />
                </IconButton>
              </span>
            </Tooltip>
            <Button
              variant="contained"
              startIcon={<AddRounded />}
              onClick={startMeetingNote}
            >
              <FormattedMessage defaultMessage="New" />
            </Button>
          </Stack>
          {noteCount > 0 && (
            <TextField
              fullWidth
              size="small"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.stopPropagation();
                  setQuery("");
                }
              }}
              placeholder={intl.formatMessage({
                defaultMessage: "Search notes",
              })}
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
              sx={[flatFieldSx, { mt: 2 }]}
            />
          )}
          {showOffline && (
            <Stack
              direction="row"
              alignItems="center"
              spacing={1}
              sx={{ mt: 1.5, color: "text.secondary" }}
              role="status"
            >
              <CloudOffOutlined sx={{ fontSize: 18 }} />
              <Typography variant="body2">
                <FormattedMessage defaultMessage="You're offline. New recordings stay on this device and upload when you're back online." />
              </Typography>
            </Stack>
          )}
          {activeNoteId && !searching && (
            <Box sx={{ mt: 2, px: 2, borderRadius: 1, bgcolor: "level1" }}>
              <NoteRow
                noteId={activeNoteId}
                snippet={null}
                highlightTerms={[]}
                when="time"
                onDelete={setPendingDeleteId}
              />
            </Box>
          )}
        </NoteColumn>
      </Box>

      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          isolation: "isolate",
        }}
      >
        {body}
      </Box>

      {loaded && noteCount > 0 && <NoteAskDock noteId={null} />}

      <ImportTranscriptDialog />
      <DeleteNoteDialog
        noteId={pendingDeleteId}
        onClose={() => setPendingDeleteId(null)}
      />
    </Box>
  );
}
