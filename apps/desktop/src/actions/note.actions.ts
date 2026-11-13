import type { Note, NoteSegment } from "@voquill/types";
import dayjs from "dayjs";
import { getNotePipeline, selectNoteStorage } from "../pipelines";
import { getMeetingAudioRepo } from "../repos";
import type { MeetingCaptureStatus } from "../repos/meeting-audio.repo";
import type { NoteAskMessage } from "../state/notes.state";
import { getAppState, produceAppState } from "../store";
import { createId } from "../utils/id.utils";
import { getLogger } from "../utils/log.utils";
import { getDefaultNoteTitle } from "../utils/note.utils";
import {
  canTransitionNote,
  recoverNoteStatus,
  transitionNote,
} from "../utils/note-state.utils";
import { getMyPreferredMicrophone } from "../utils/user.utils";
import { addNoteSegment, loadNotes, noteStore } from "./note-store.actions";

export const CAPTURE_INTERRUPTED_ERROR_CODE = "capture_interrupted";

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

const startSegmentCapture = async (noteId: string): Promise<void> => {
  const segments = await noteStore.loadSegments(noteId);
  const segmentId = createId();
  const status = await getMeetingAudioRepo().startCapture({
    noteId,
    segmentId,
    preferredMicrophone: getMyPreferredMicrophone(getAppState()),
  });
  produceAppState((draft) => {
    draft.notes.capture = status;
    draft.notes.activeNoteId = noteId;
  });
  await addNoteSegment({
    id: segmentId,
    noteId,
    index: segments.reduce(
      (max, segment) => Math.max(max, segment.index + 1),
      0,
    ),
    kind: "audio",
    status: "recording",
    durationMs: 0,
    createdAt: dayjs().toISOString(),
    transcript: null,
    transcribedMs: 0,
    audioPath: status.audioPath,
  });
};

/** Finalizes the segment being captured, if any; returns its note id. */
const stopSegmentCapture = async (): Promise<string | null> => {
  const stopped = await getMeetingAudioRepo().stopCapture();
  produceAppState((draft) => {
    draft.notes.capture = null;
  });
  if (!stopped) {
    return null;
  }
  await noteStore.updateSegment(
    stopped.noteId,
    stopped.segmentId,
    (segment) => {
      segment.status = "recorded";
      segment.durationMs = stopped.durationMs;
    },
  );
  await noteStore.updateNote(stopped.noteId, (note) => {
    note.durationMs = sumSegmentDurations(noteStore.getSegments(note.id));
  });
  return stopped.noteId;
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
    const note: Note = {
      id: createId(),
      storage: selectNoteStorage(getAppState()),
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
    };
    await noteStore.insertNote(note, []);
    try {
      await startSegmentCapture(note.id);
    } catch (error) {
      await noteStore.deleteNote(note.id);
      throw error;
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
const interruptMeetingNote = (noteId: string): Promise<void> =>
  serializeCapture(async () => {
    if (getAppState().notes.capture?.noteId !== noteId) {
      return;
    }
    await stopSegmentCapture();
    await noteStore.updateNote(noteId, (note) => {
      note.status = transitionNote(note.status, "interrupt");
      note.error = {
        code: CAPTURE_INTERRUPTED_ERROR_CODE,
        message: "The microphone stopped delivering audio",
      };
    });
  });

export const handleMeetingCaptureProgress = (status: MeetingCaptureStatus) => {
  const current = getAppState().notes.capture;
  if (current?.segmentId !== status.segmentId) {
    return;
  }
  produceAppState((draft) => {
    draft.notes.capture = status;
  });
  if (status.interrupted && !current.interrupted) {
    void interruptMeetingNote(status.noteId).catch((error) => {
      getLogger().error(`Failed to pause interrupted meeting: ${error}`);
    });
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

/**
 * Loads notes and re-enters every note's lifecycle after a launch: recordings
 * cut off by a quit or crash become paused notes with their partial audio,
 * and interrupted processing resumes where it stopped.
 */
export const initializeNotes = async (): Promise<void> => {
  const notes = await loadNotes();
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

  for (const note of noteStore.getNotes()) {
    const pipeline = getNotePipeline(note.storage);
    void runPipeline(note.id, (id) => pipeline.resumeAfterRestart(id));
  }
};

export const loadNoteSegments = (noteId: string) =>
  noteStore.loadSegments(noteId);

export const renameNote = async (noteId: string, title: string) => {
  const trimmed = title.trim();
  if (!trimmed) {
    return;
  }
  await noteStore.updateNote(noteId, (note) => {
    note.title = trimmed;
    note.titleSource = "user";
  });
};

export const setNotePersonalNotes = (noteId: string, personalNotes: string) =>
  noteStore.updateNote(noteId, (note) => {
    note.personalNotes = personalNotes;
  });

export const retryNote = async (noteId: string) => {
  await noteStore.updateNote(noteId, (note) => {
    note.status = transitionNote(note.status, "retry");
  });
  processNote(noteId);
};

export const regenerateNote = (noteId: string) => {
  const pipeline = getPipelineFor(noteId);
  if (pipeline) {
    void runPipeline(noteId, (id) => pipeline.regenerate(id));
  }
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
        streaming: false,
      },
      {
        id: answerId,
        role: "assistant",
        content: "",
        sources: [],
        error: null,
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
        if (event.type === "sources" || event.type === "done") {
          message.sources = event.sources;
        } else if (event.type === "delta") {
          message.content += event.text;
        } else {
          message.error = event.message;
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
