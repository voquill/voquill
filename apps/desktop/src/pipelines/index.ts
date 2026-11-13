import type { NoteStorage } from "@voquill/types";
import { syncCloudNotes } from "../actions/note-sync.actions";
import { noteStore } from "../actions/note-store.actions";
import { transcribeAudio } from "../actions/transcribe.actions";
import {
  getCloudNoteRepo,
  getGenerateTextRepo,
  getMeetingAudioRepo,
  getNoteRepo,
} from "../repos";
import { getAppState, produceAppState } from "../store";
import {
  getCloudNotesUserId,
  getNoteGenerationAvailable,
  getNoteGenerationContextTokens,
} from "../utils/note.utils";
import { collectDictionaryEntries } from "../utils/prompt.utils";
import { applyReplacements } from "../utils/string.utils";
import type { BaseNotePipeline } from "./base-note.pipeline";
import { CloudNotePipeline, type Connectivity } from "./cloud-note.pipeline";
import { LocalNotePipeline } from "./local-note.pipeline";

export { selectNoteStorage } from "../utils/note.utils";

const getChatGenerator = () =>
  getNoteGenerationAvailable(getAppState()) ? getGenerateTextRepo().repo : null;

let localNotePipeline: LocalNotePipeline | null = null;

const getLocalNotePipeline = (): LocalNotePipeline => {
  localNotePipeline ??= new LocalNotePipeline({
    store: noteStore,
    repo: getNoteRepo(),
    audio: getMeetingAudioRepo(),
    transcribe: async ({ samples, sampleRate }) => {
      const { rawTranscript } = await transcribeAudio({ samples, sampleRate });
      const replacements = collectDictionaryEntries(
        getAppState(),
      ).replacements.map((rule) => ({
        sourceValue: rule.source,
        destinationValue: rule.destination,
      }));
      return applyReplacements(rawTranscript, replacements);
    },
    getGenerationModel: () => {
      const generator = getChatGenerator();
      return generator
        ? {
            generator,
            contextTokens: getNoteGenerationContextTokens(getAppState()),
          }
        : null;
    },
    getChatGenerator,
    getCloudNotesUserId: () => getCloudNotesUserId(getAppState()),
  });
  return localNotePipeline;
};

const isOnline = () => typeof navigator === "undefined" || navigator.onLine;

/** Resolves after `ms`, or as soon as the device comes back online. */
const sleepUntilOnlineOr = (ms: number) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timeout);
      window.removeEventListener("online", done);
      resolve();
    };
    const timeout = setTimeout(done, ms);
    window.addEventListener("online", done);
  });

const connectivity: Connectivity = {
  isOnline,
  waitUntilOnline: () =>
    isOnline()
      ? Promise.resolve()
      : new Promise((resolve) =>
          window.addEventListener("online", () => resolve(), { once: true }),
        ),
};

let cloudNotePipeline: CloudNotePipeline | null = null;

export const getCloudNotePipeline = (): CloudNotePipeline => {
  cloudNotePipeline ??= new CloudNotePipeline({
    store: noteStore,
    repo: getNoteRepo(),
    api: getCloudNoteRepo(),
    audio: getMeetingAudioRepo(),
    connectivity,
    sleep: sleepUntilOnlineOr,
    now: () => Date.now(),
    getCloudNotesUserId: () => getCloudNotesUserId(getAppState()),
    setActivity: (noteId, activity) => {
      produceAppState((draft) => {
        if (activity) {
          draft.notes.cloudActivityByNoteId[noteId] = activity;
        } else {
          delete draft.notes.cloudActivityByNoteId[noteId];
        }
      });
    },
    onSettled: () => {
      void syncCloudNotes({ force: true });
    },
  });
  return cloudNotePipeline;
};

export const getNotePipeline = (storage: NoteStorage): BaseNotePipeline => {
  switch (storage) {
    case "local":
      return getLocalNotePipeline();
    case "cloud":
      return getCloudNotePipeline();
  }
};
