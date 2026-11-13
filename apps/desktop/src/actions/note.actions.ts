import type {
  Note,
  NoteEditableField,
  NoteError,
  NoteSegment,
} from "@voquill/types";
import dayjs from "dayjs";
import {
  getCloudNotePipeline,
  getNotePipeline,
  selectNoteStorage,
} from "../pipelines";
import { NotesApiError } from "../repos/cloud-note.repo";
import { getMeetingAudioRepo } from "../repos";
import type {
  MeetingCaptureStatus,
  ResumableUploadProgress,
} from "../repos/meeting-audio.repo";
import type { NoteAskMessage } from "../state/notes.state";
import { getAppState, produceAppState } from "../store";
import { createId } from "../utils/id.utils";
import { getLogger } from "../utils/log.utils";
import {
  createNoteCloudSync,
  getCloudNotesUserId,
  getDefaultNoteTitle,
  getNoteElapsedMs,
} from "../utils/note.utils";
import {
  canTransitionNote,
  recoverNoteStatus,
  transitionNote,
} from "../utils/note-state.utils";
import { getMyPreferredMicrophone } from "../utils/user.utils";
import {
  canAppendToNoteSegment,
  getNoteCaptureAction,
  getNoteResumeBlocker,
} from "../utils/note-audio.utils";
import { needsFullNoteFetch } from "../utils/note-sync.utils";
import { syncCloudNotes } from "./note-sync.actions";
import { addNoteSegment, loadNotes, noteStore } from "./note-store.actions";

export const CAPTURE_INTERRUPTED_ERROR_CODE = "capture_interrupted";
export const CAPTURE_WRITE_FAILED_ERROR_CODE = "capture_write_failed";
export const NOTE_LENGTH_LIMIT_ERROR_CODE = "note_length_limit";

/** Recording cannot continue in this note (`code` says why). */
export class NoteRecordingBlockedError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

let captureQueue: Promise<unknown> = Promise.resolve();

/** Capture start/stop calls run one at a time so rapid clicks cannot race. */
const serializeCapture = <T>(task: () => Promise<T>): Promise<T> => {
  const run = captureQueue.then(task);
  captureQueue = run.catch(() => undefined);
  return run;
};

const runPipeline = (noteId: string, task: (noteId: string) => Promise<void>) =>
  task(noteId).catch((error) => {
    getLogger().error(`Note pipeline task failed: ${error}`);
  });

const getPipelineFor = (noteId: string) => {
  const note = noteStore.getNote(noteId);
  return note ? getNotePipeline(note.storage) : null;
};

const processNote = (noteId: string) => {
  const pipeline = getPipelineFor(noteId);
  if (pipeline) {
    void runPipeline(noteId, (id) => pipeline.process(id));
  }
};

const sumSegmentDurations = (segments: NoteSegment[]) =>
  segments.reduce((total, segment) => total + segment.durationMs, 0);

const nextSegmentIndex = (segments: NoteSegment[]) =>
  segments.reduce((max, segment) => Math.max(max, segment.index + 1), 0);

const lastSegment = (segments: NoteSegment[]) =>
  [...segments].sort((left, right) => right.index - left.index)[0];

/**
 * Starts capturing, continuing the last segment when it has not been sent
 * anywhere yet (so pauses never use up segments), otherwise in a new one.
 */
const startSegmentCapture = async (noteId: string): Promise<void> => {
  const segments = await noteStore.loadSegments(noteId);
  const audio = getMeetingAudioRepo();
  const preferredMicrophone = getMyPreferredMicrophone(getAppState());
  const markCapturing = (status: MeetingCaptureStatus) =>
    produceAppState((draft) => {
      draft.notes.capture = status;
      draft.notes.activeNoteId = noteId;
    });

  const last = lastSegment(segments);
  if (last && canAppendToNoteSegment(last)) {
    try {
      const status = await audio.startCapture({
        noteId,
        segmentId: last.id,
        append: true,
        preferredMicrophone,
      });
      markCapturing(status);
      await noteStore.updateSegment(noteId, last.id, (segment) => {
        segment.status = "recording";
      });
      return;
    } catch (error) {
      getLogger().warning(`Could not continue the last segment: ${error}`);
    }
  }

  const segmentId = createId();
  const status = await audio.startCapture({
    noteId,
    segmentId,
    append: false,
    preferredMicrophone,
  });
  markCapturing(status);
  await addNoteSegment(
    newRecordingSegment(noteId, segmentId, segments, status),
  );
};

const newRecordingSegment = (
  noteId: string,
  segmentId: string,
  segments: NoteSegment[],
  status: MeetingCaptureStatus,
): NoteSegment => ({
  id: segmentId,
  noteId,
  index: nextSegmentIndex(segments),
  kind: "audio",
  status: "recording",
  error: null,
  durationMs: 0,
  createdAt: dayjs().toISOString(),
  transcript: null,
  transcribedMs: 0,
  audioPath: status.audioPath,
  upload: null,
});

/** Continues the running capture in a new segment before the file grows too big. */
const rollSegmentCapture = (noteId: string): Promise<void> =>
  serializeCapture(async () => {
    if (getAppState().notes.capture?.noteId !== noteId) {
      return;
    }
    const segments = noteStore.getSegments(noteId);
    const segmentId = createId();
    const rolled = await getMeetingAudioRepo().rollCapture(noteId, segmentId);
    produceAppState((draft) => {
      draft.notes.capture = rolled.status;
    });
    await noteStore.updateSegment(
      noteId,
      rolled.finished.segmentId,
      (segment) => {
        segment.status = "recorded";
        segment.durationMs = rolled.finished.durationMs;
      },
    );
    await addNoteSegment(
      newRecordingSegment(noteId, segmentId, segments, rolled.status),
    );
    await noteStore.updateNote(noteId, (note) => {
      note.durationMs = sumSegmentDurations(noteStore.getSegments(noteId));
    });
  });

/**
 * Finalizes the segment being captured. If the native layer no longer has
 * the capture, the segment's duration is recovered from its file.
 */
const stopSegmentCapture = async (): Promise<void> => {
  const expected = getAppState().notes.capture;
  const audio = getMeetingAudioRepo();
  const stopped = await audio.stopCapture();
  produceAppState((draft) => {
    draft.notes.capture = null;
  });
  const finished = stopped ?? expected;
  if (!finished) {
    return;
  }
  const durationMs = stopped
    ? stopped.durationMs
    : await audio.repairSegment(finished.audioPath);
  await noteStore.updateSegment(
    finished.noteId,
    finished.segmentId,
    (segment) => {
      segment.status = "recorded";
      segment.durationMs = durationMs;
    },
  );
  await noteStore.updateNote(finished.noteId, (note) => {
    note.durationMs = sumSegmentDurations(noteStore.getSegments(note.id));
  });
};

/**
 * Creates a note and starts recording it, or returns the meeting already in
 * progress (only one note records at a time).
 */
export const startMeetingNote = (): Promise<{
  noteId: string;
  alreadyActive: boolean;
}> =>
  serializeCapture(async () => {
    const activeNoteId = getAppState().notes.activeNoteId;
    if (activeNoteId && noteStore.getNote(activeNoteId)) {
      return { noteId: activeNoteId, alreadyActive: true };
    }

    const now = dayjs().toISOString();
    const storage = selectNoteStorage(getAppState());
    const note: Note = {
      id: createId(),
      storage,
      status: "recording",
      title: getDefaultNoteTitle("recording", now),
      titleSource: "default",
      error: null,
      source: "recording",
      personalNotes: "",
      generatedNotes: null,
      durationMs: 0,
      createdAt: now,
      updatedAt: now,
      cloud: createNoteCloudSync(storage, getCloudNotesUserId(getAppState())),
    };
    await noteStore.insertNote(note, []);
    try {
      await startSegmentCapture(note.id);
    } catch (error) {
      await noteStore.deleteNote(note.id, { deleteAudio: true });
      throw error;
    }
    if (note.cloud) {
      scheduleSaveEdits(note.id, 0);
    }
    return { noteId: note.id, alreadyActive: false };
  });

export const pauseMeetingNote = (noteId: string): Promise<void> =>
  serializeCapture(async () => {
    if (getAppState().notes.capture?.noteId !== noteId) {
      return;
    }
    await stopSegmentCapture();
    await noteStore.updateNote(noteId, (note) => {
      note.status = transitionNote(note.status, "pause");
    });
  });

/**
 * Records more audio into a paused or ready note. Returns the id of another
 * meeting that is in progress instead of starting, if there is one.
 */
export const resumeMeetingNote = (noteId: string): Promise<string | null> =>
  serializeCapture(async () => {
    const activeNoteId = getAppState().notes.activeNoteId;
    if (
      activeNoteId &&
      activeNoteId !== noteId &&
      noteStore.getNote(activeNoteId)
    ) {
      return activeNoteId;
    }
    const note = noteStore.getNote(noteId);
    if (
      !note ||
      getAppState().notes.capture ||
      !canTransitionNote(note.status, "resume")
    ) {
      return null;
    }
    const blocker = getNoteResumeBlocker({
      noteElapsedMs: note.durationMs,
      segments: await loadNoteSegments(noteId),
    });
    if (blocker) {
      throw new NoteRecordingBlockedError(blocker);
    }
    await startSegmentCapture(noteId);
    await noteStore.updateNote(noteId, (draft) => {
      draft.status = transitionNote(draft.status, "resume");
      draft.error = null;
    });
    return null;
  });

/** Ends the meeting and hands it to the pipeline. */
export const stopMeetingNote = (noteId: string): Promise<void> =>
  serializeCapture(async () => {
    if (getAppState().notes.capture?.noteId === noteId) {
      await stopSegmentCapture();
    }
    produceAppState((draft) => {
      if (draft.notes.activeNoteId === noteId) {
        draft.notes.activeNoteId = null;
      }
    });
    const note = noteStore.getNote(noteId);
    if (note?.status !== "recording" && note?.status !== "paused") {
      return;
    }
    await noteStore.updateNote(noteId, (draft) => {
      draft.status = transitionNote(draft.status, "finish");
      draft.error = null;
    });
    processNote(noteId);
  });

/** The microphone stopped delivering audio: keep what was captured, pause. */
/**
 * Pauses a capture that cannot continue, keeping everything recorded:
 * the microphone stopped, the disk refused writes, or the note reached the
 * recording limit.
 */
const haltMeetingNote = (
  noteId: string,
  event: "interrupt" | "pause",
  error: NoteError,
): Promise<void> =>
  serializeCapture(async () => {
    if (getAppState().notes.capture?.noteId !== noteId) {
      return;
    }
    await stopSegmentCapture();
    await noteStore.updateNote(noteId, (note) => {
      if (canTransitionNote(note.status, event)) {
        note.status = transitionNote(note.status, event);
      }
      note.error = error;
    });
  });

let captureActionInFlight = false;

const runCaptureAction = (task: () => Promise<void>) => {
  if (captureActionInFlight) {
    return;
  }
  captureActionInFlight = true;
  void task()
    .catch((error) => {
      getLogger().error(`Meeting capture action failed: ${error}`);
    })
    .finally(() => {
      captureActionInFlight = false;
    });
};

export const handleMeetingCaptureProgress = (status: MeetingCaptureStatus) => {
  const current = getAppState().notes.capture;
  if (current?.segmentId !== status.segmentId) {
    return;
  }
  produceAppState((draft) => {
    draft.notes.capture = status;
  });
  const noteId = status.noteId;

  if (status.interruption) {
    runCaptureAction(() =>
      haltMeetingNote(noteId, "interrupt", {
        code:
          status.interruption === "write-failed"
            ? CAPTURE_WRITE_FAILED_ERROR_CODE
            : CAPTURE_INTERRUPTED_ERROR_CODE,
        message: "Recording stopped unexpectedly",
      }),
    );
    return;
  }

  const action = getNoteCaptureAction({
    noteElapsedMs: getNoteElapsedMs(getAppState(), noteId),
    segmentMs: status.durationMs,
    segmentCount: noteStore.getSegments(noteId).length,
  });
  if (action === "roll") {
    runCaptureAction(() => rollSegmentCapture(noteId));
  } else if (action === "stop") {
    runCaptureAction(() =>
      haltMeetingNote(noteId, "pause", {
        code: NOTE_LENGTH_LIMIT_ERROR_CODE,
        message: "The meeting reached the recording limit",
      }),
    );
  }
};

const recoverRecordingNote = async (
  note: Note,
  capture: MeetingCaptureStatus | null,
) => {
  if (capture?.noteId === note.id) {
    await noteStore.loadSegments(note.id);
    produceAppState((draft) => {
      draft.notes.capture = capture;
      draft.notes.activeNoteId = note.id;
    });
    return;
  }

  const audio = getMeetingAudioRepo();
  for (const segment of await noteStore.loadSegments(note.id)) {
    if (segment.status !== "recording" || !segment.audioPath) {
      continue;
    }
    const durationMs = await audio
      .repairSegment(segment.audioPath)
      .catch((error) => {
        getLogger().error(`Failed to repair meeting audio: ${error}`);
        return segment.durationMs;
      });
    await noteStore.updateSegment(note.id, segment.id, (draft) => {
      draft.status = "recorded";
      draft.durationMs = durationMs;
    });
  }
  await noteStore.updateNote(note.id, (draft) => {
    draft.status = recoverNoteStatus(draft.status, false);
    draft.durationMs = sumSegmentDurations(noteStore.getSegments(note.id));
    draft.error = {
      code: CAPTURE_INTERRUPTED_ERROR_CODE,
      message: "Recording was interrupted when Voquill closed",
    };
  });
};

const RECOVERED_AUDIO_ERROR: NoteError = {
  code: CAPTURE_INTERRUPTED_ERROR_CODE,
  message: "Recording was interrupted",
};

/**
 * Meeting audio on disk that no segment references (a crash between the
 * native layer creating a file and the app storing its segment) becomes a
 * segment of its note again, or of a recovered note, never discarded.
 */
const adoptUnreferencedAudio = async (): Promise<void> => {
  const orphans = await getMeetingAudioRepo().listUnreferencedAudio();
  for (const orphan of orphans) {
    if (orphan.durationMs <= 0) {
      continue;
    }
    let note = noteStore.getNote(orphan.noteId);
    if (!note && orphan.noteExists) {
      // Another account's note: it adopts the file when that account is back.
      continue;
    }
    if (note && note.status !== "paused" && note.status !== "recording") {
      getLogger().warning(
        "Meeting audio found for a note that is not recording",
      );
      continue;
    }
    if (!note) {
      const now = dayjs().toISOString();
      const storage = selectNoteStorage(getAppState());
      note = {
        id: orphan.noteId,
        storage,
        status: "paused",
        title: getDefaultNoteTitle("recording", now),
        titleSource: "default",
        error: RECOVERED_AUDIO_ERROR,
        source: "recording",
        personalNotes: "",
        generatedNotes: null,
        durationMs: 0,
        createdAt: now,
        updatedAt: now,
        cloud: createNoteCloudSync(storage, getCloudNotesUserId(getAppState())),
      };
      await noteStore.insertNote(note, []);
    }
    const segments = await noteStore.loadSegments(note.id);
    await addNoteSegment({
      id: orphan.segmentId,
      noteId: note.id,
      index: nextSegmentIndex(segments),
      kind: "audio",
      status: "recorded",
      error: null,
      durationMs: orphan.durationMs,
      createdAt: dayjs().toISOString(),
      transcript: null,
      transcribedMs: 0,
      audioPath: orphan.audioPath,
      upload: null,
    });
    await noteStore.updateNote(note.id, (draft) => {
      draft.durationMs = sumSegmentDurations(noteStore.getSegments(draft.id));
      draft.error = RECOVERED_AUDIO_ERROR;
    });
  }
};

/**
 * Loads notes and re-enters every note's lifecycle, after a launch or when
 * the signed-in account changes: recordings cut off by a quit or crash
 * become paused notes with their partial audio, and interrupted processing
 * resumes where it stopped.
 */
export const initializeNotes = async (): Promise<void> => {
  const userId = getCloudNotesUserId(getAppState());
  const { loaded, loadedForUserId } = getAppState().notes;
  if (loaded && loadedForUserId === userId) {
    return;
  }
  const notes = await loadNotes(userId);
  const capture = await getMeetingAudioRepo()
    .getCaptureStatus()
    .catch(() => null);

  for (const note of notes.filter((note) => note.status === "recording")) {
    await recoverRecordingNote(note, capture).catch((error) => {
      getLogger().error(`Failed to recover meeting note: ${error}`);
    });
  }

  for (const note of notes) {
    if (note.status === "processing") {
      await noteStore.updateNote(note.id, (draft) => {
        draft.status = recoverNoteStatus(draft.status, false);
      });
    }
  }

  await adoptUnreferencedAudio().catch((error) => {
    getLogger().error(`Failed to recover unreferenced meeting audio: ${error}`);
  });

  for (const note of noteStore.getNotes()) {
    const pipeline = getNotePipeline(note.storage);
    void runPipeline(note.id, (id) => pipeline.resumeAfterRestart(id));
  }
  void syncCloudNotes({ force: true });
};

/** Segments for display; a cloud note's are fetched when the cached copy is stale. */
export const loadNoteSegments = async (noteId: string) => {
  const note = noteStore.getNote(noteId);
  if (note && needsFullNoteFetch(note)) {
    await getNotePipeline(note.storage).refresh(noteId);
  }
  return noteStore.loadSegments(noteId);
};

/** Personal-notes edits re-index search server-side, so they are batched. */
const SAVE_EDITS_DEBOUNCE_MS = 3_000;
const saveEditsTimeoutByNoteId = new Map<
  string,
  ReturnType<typeof setTimeout>
>();

const scheduleSaveEdits = (noteId: string, delayMs: number) => {
  clearTimeout(saveEditsTimeoutByNoteId.get(noteId));
  saveEditsTimeoutByNoteId.set(
    noteId,
    setTimeout(() => {
      saveEditsTimeoutByNoteId.delete(noteId);
      const pipeline = getPipelineFor(noteId);
      if (pipeline) {
        void runPipeline(noteId, (id) => pipeline.saveEdits(id));
      }
    }, delayMs),
  );
};

const editNote = async (
  noteId: string,
  field: NoteEditableField,
  recipe: (note: Note) => void,
  saveDelayMs: number,
) => {
  await noteStore.updateNote(noteId, (note) => {
    recipe(note);
    if (note.cloud && !note.cloud.unsyncedFields.includes(field)) {
      note.cloud.unsyncedFields.push(field);
    }
  });
  if (noteStore.getNote(noteId)?.cloud) {
    scheduleSaveEdits(noteId, saveDelayMs);
  }
};

export const renameNote = async (noteId: string, title: string) => {
  const trimmed = title.trim();
  if (!trimmed) {
    return;
  }
  await editNote(
    noteId,
    "title",
    (note) => {
      note.title = trimmed;
      note.titleSource = "user";
    },
    0,
  );
};

export const setNotePersonalNotes = (noteId: string, personalNotes: string) =>
  editNote(
    noteId,
    "personalNotes",
    (note) => {
      note.personalNotes = personalNotes;
    },
    SAVE_EDITS_DEBOUNCE_MS,
  );

/** Sends every cloud edit made offline once the connection is back. */
export const saveUnsyncedNoteEdits = () => {
  for (const note of noteStore.getNotes()) {
    if (note.cloud && note.cloud.unsyncedFields.length > 0) {
      scheduleSaveEdits(note.id, 0);
    }
  }
};

export const retryNote = async (noteId: string) => {
  await noteStore.updateNote(noteId, (note) => {
    note.status = transitionNote(note.status, "retry");
  });
  processNote(noteId);
};

/** Returns why the request was refused (the note then stays as it was). */
export const regenerateNote = async (
  noteId: string,
): Promise<NoteError | null> => {
  try {
    await getPipelineFor(noteId)?.regenerate(noteId);
    return null;
  } catch (error) {
    getLogger().warning(`Regenerating notes was refused: ${error}`);
    return error instanceof NotesApiError
      ? { code: error.code, message: error.message, details: error.details }
      : { code: "unknown", message: String(error) };
  }
};

export const retryNoteSegment = async (noteId: string, segmentId: string) => {
  await getCloudNotePipeline().retrySegment(noteId, segmentId);
};

export const dropNoteSegment = async (noteId: string, segmentId: string) => {
  await getCloudNotePipeline().dropSegment(noteId, segmentId);
};

export const handleResumableUploadProgress = (
  progress: ResumableUploadProgress,
) => {
  produceAppState((draft) => {
    for (const activity of Object.values(draft.notes.cloudActivityByNoteId)) {
      if (
        activity.kind === "uploading" &&
        activity.segmentId === progress.uploadId
      ) {
        activity.uploadedBytes = progress.uploadedBytes;
        activity.totalBytes = progress.totalBytes;
      }
    }
  });
};

export const deleteNote = async (noteId: string) => {
  await serializeCapture(async () => {
    if (getAppState().notes.capture?.noteId === noteId) {
      await stopSegmentCapture();
    }
    produceAppState((draft) => {
      if (draft.notes.activeNoteId === noteId) {
        draft.notes.activeNoteId = null;
      }
    });
  });
  await getPipelineFor(noteId)?.deleteNote(noteId);
};

/** Starts generation in the background and returns the new note's id. */
export const importNoteTranscript = ({
  title,
  transcript,
}: {
  title: string;
  transcript: string;
}): string => {
  const id = createId();
  const pipeline = getNotePipeline(selectNoteStorage(getAppState()));
  void runPipeline(id, () =>
    pipeline.importTranscript({
      id,
      title,
      transcript,
      defaultTitle: getDefaultNoteTitle("import", dayjs().toISOString()),
    }),
  );
  return id;
};

export const searchNotes = (query: string) =>
  getNotePipeline(selectNoteStorage(getAppState())).search(query);

export const openImportTranscriptDialog = () => {
  produceAppState((draft) => {
    draft.notes.importDialogOpen = true;
  });
};

export const closeImportTranscriptDialog = () => {
  produceAppState((draft) => {
    draft.notes.importDialogOpen = false;
  });
};

export const openNotesAsk = (noteId: string | null) => {
  produceAppState((draft) => {
    if (draft.notes.askNoteId !== noteId) {
      draft.notes.askMessages = [];
    }
    draft.notes.askNoteId = noteId;
    draft.notes.askDialogOpen = true;
  });
};

export const closeNotesAsk = () => {
  produceAppState((draft) => {
    draft.notes.askDialogOpen = false;
  });
};

const updateAskMessage = (
  messageId: string,
  recipe: (message: NoteAskMessage) => void,
) => {
  produceAppState((draft) => {
    const message = draft.notes.askMessages.find(
      (candidate) => candidate.id === messageId,
    );
    if (message) {
      recipe(message);
    }
  });
};

export const askNotes = async (question: string): Promise<void> => {
  const trimmed = question.trim();
  const { askNoteId, askMessages } = getAppState().notes;
  if (!trimmed || askMessages.some((message) => message.streaming)) {
    return;
  }

  const history = askMessages
    .filter((message) => !message.error && message.content)
    .map((message) => ({ role: message.role, content: message.content }));
  const answerId = createId();
  produceAppState((draft) => {
    draft.notes.askMessages.push(
      {
        id: createId(),
        role: "user",
        content: trimmed,
        sources: [],
        error: null,
        errorDetails: null,
        streaming: false,
      },
      {
        id: answerId,
        role: "assistant",
        content: "",
        sources: [],
        error: null,
        errorDetails: null,
        streaming: true,
      },
    );
  });

  try {
    const storage = askNoteId
      ? (noteStore.getNote(askNoteId)?.storage ?? "local")
      : selectNoteStorage(getAppState());
    const events = getNotePipeline(storage).ask({
      question: trimmed,
      noteId: askNoteId,
      history,
    });
    for await (const event of events) {
      updateAskMessage(answerId, (message) => {
        if (event.type === "sources") {
          message.sources = event.sources;
        } else if (event.type === "done") {
          message.sources = event.sources;
          message.content = event.answer || message.content;
        } else if (event.type === "delta") {
          message.content += event.text;
        } else {
          message.error = event.message;
          message.errorDetails = event.details ?? null;
        }
      });
    }
  } catch (error) {
    updateAskMessage(answerId, (message) => {
      message.error = error instanceof Error ? error.message : String(error);
    });
  } finally {
    updateAskMessage(answerId, (message) => {
      message.streaming = false;
    });
  }
};
