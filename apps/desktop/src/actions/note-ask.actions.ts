import type { Nullable } from "@voquill/types";
import { getNotePipeline, selectNoteStorage } from "../pipelines";
import {
  getNoteAskKey,
  type NoteAskMessage,
  type NoteAskThread,
} from "../state/notes.state";
import { getAppState, produceAppState } from "../store";
import type { AppState } from "../state/app.state";
import { createId } from "../utils/id.utils";
import { getNoteErrorAvailableAt } from "../utils/note-error.utils";
import { noteStore } from "./note-store.actions";

/** In-flight answers by thread key. */
const activeAsks = new Map<string, AbortController>();

const newMessage = (
  role: NoteAskMessage["role"],
  content: string,
  streaming: boolean,
): NoteAskMessage => ({
  id: createId(),
  role,
  content,
  sources: [],
  error: null,
  errorDetails: null,
  streaming,
  stopped: false,
});

export const getNoteAskThread = (
  state: AppState,
  noteId: Nullable<string>,
): NoteAskThread | undefined =>
  state.notes.askThreadByKey[getNoteAskKey(noteId)];

const produceThread = (
  noteId: Nullable<string>,
  recipe: (thread: NoteAskThread) => void,
) => {
  produceAppState((draft) => {
    const key = getNoteAskKey(noteId);
    const thread = (draft.notes.askThreadByKey[key] ??= {
      messages: [],
      expanded: false,
    });
    recipe(thread);
  });
};

const updateAnswer = (
  noteId: Nullable<string>,
  messageId: string,
  recipe: (message: NoteAskMessage) => void,
) => {
  produceThread(noteId, (thread) => {
    const message = thread.messages.find((m) => m.id === messageId);
    if (message) {
      recipe(message);
    }
  });
};

export const setNotesAskExpanded = (
  noteId: Nullable<string>,
  expanded: boolean,
) => {
  produceThread(noteId, (thread) => {
    thread.expanded = expanded && thread.messages.length > 0;
  });
};

export const stopAskingNotes = (noteId: Nullable<string>) => {
  activeAsks.get(getNoteAskKey(noteId))?.abort();
};

export const clearNotesAsk = (noteId: Nullable<string>) => {
  stopAskingNotes(noteId);
  produceAppState((draft) => {
    delete draft.notes.askThreadByKey[getNoteAskKey(noteId)];
  });
};

/**
 * Asks about a note, or with null across all notes; the answer streams into
 * that place's thread, and earlier turns are sent as the conversation.
 */
export const askNotes = async (
  noteId: Nullable<string>,
  question: string,
): Promise<void> => {
  const trimmed = question.trim();
  const key = getNoteAskKey(noteId);
  const messages = getNoteAskThread(getAppState(), noteId)?.messages ?? [];
  if (!trimmed || activeAsks.has(key)) {
    return;
  }

  const history = messages
    .filter((message) => !message.error && !message.stopped && message.content)
    .map((message) => ({ role: message.role, content: message.content }));
  const answer = newMessage("assistant", "", true);
  produceThread(noteId, (thread) => {
    thread.messages.push(newMessage("user", trimmed, false), answer);
    thread.expanded = true;
  });

  const controller = new AbortController();
  activeAsks.set(key, controller);
  try {
    const storage = noteId
      ? (noteStore.getNote(noteId)?.storage ?? "local")
      : selectNoteStorage(getAppState());
    const events = getNotePipeline(storage).ask({
      question: trimmed,
      noteId,
      history,
      signal: controller.signal,
    });
    for await (const event of events) {
      if (controller.signal.aborted) {
        break;
      }
      updateAnswer(noteId, answer.id, (message) => {
        if (event.type === "sources") {
          message.sources = event.sources;
        } else if (event.type === "done") {
          message.sources = event.sources;
          // The final answer is authoritative; streamed blocks were a preview.
          message.content = event.answer;
        } else if (event.type === "delta") {
          message.content += event.text;
        } else {
          message.error = event.message;
          message.errorDetails = event.details ?? null;
        }
      });
      if (event.type === "error" && event.message === "ask_limit_exceeded") {
        const resetsAt = getNoteErrorAvailableAt(event.details);
        produceAppState((draft) => {
          draft.notes.askLimitResetsAt = resetsAt?.toISOString() ?? null;
        });
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      updateAnswer(noteId, answer.id, (message) => {
        message.error = error instanceof Error ? error.message : String(error);
      });
    }
  } finally {
    activeAsks.delete(key);
    updateAnswer(noteId, answer.id, (message) => {
      message.streaming = false;
      message.stopped = controller.signal.aborted && !message.error;
    });
  }
};
