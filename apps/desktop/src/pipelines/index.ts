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
import { getAppState, produceAppState, useAppStore } from "../store";
import {
  DEFAULT_NOTE_CHUNK_LIMITS,
  LOCAL_WHISPER_NOTE_CHUNK_LIMITS,
} from "../utils/note-audio.utils";
import { getTranscriptionPrefs } from "../utils/user.utils";
import {
  getCloudNotesUserId,
  getLocalNoteProcessedWith,
  getLocalNoteTranscribesWithVoquill,
  getLocalNoteTranscriptionBlocked,
  getLocalNoteTranscriptionWordBudget,
  getNoteGenerationAvailable,
  getNoteGenerationContextTokens,
} from "../utils/note.utils";
import { collectDictionaryEntries } from "../utils/prompt.utils";
import { applyReplacements } from "../utils/string.utils";
import type { BaseNotePipeline } from "./base-note.pipeline";
import { CloudNotePipeline, type Connectivity } from "./cloud-note.pipeline";
import {
  DICTATION_WORDS_EXCEEDED_ERROR_CODE,
  LocalNotePipeline,
  NoteProcessingError,
} from "./local-note.pipeline";
import { getTranscriptionAttemptTimeout } from "../sessions";
import { runWithAttemptTimeout } from "../utils/abort.utils";

export { selectNoteStorage } from "../utils/note.utils";

const DICTATION_SETTLE_MS = 1_500;

/** The error code Voquill's transcription service sends when the words run out. */
const VOQUILL_WORD_QUOTA_ERROR = "QUOTA_EXCEEDED";

const dictationWordsExceeded = () =>
  new NoteProcessingError(
    DICTATION_WORDS_EXCEEDED_ERROR_CODE,
    "Voquill cloud transcription is out of words",
    { remainingWords: 0 },
  );

/**
 * Resolves once no dictation is recording or transcribing (and a moment has
 * passed since), so note work queued behind it starts only after the user's
 * dictation is done.
 */
const yieldToDictation = async (): Promise<void> => {
  const isDictating = () => getAppState().overlayPhase !== "idle";
  if (!isDictating()) {
    return;
  }
  for (;;) {
    await new Promise<void>((resolve) => {
      const unsubscribe = useAppStore.subscribe((state) => {
        if (state.overlayPhase === "idle") {
          unsubscribe();
          resolve();
        }
      });
      if (!isDictating()) {
        unsubscribe();
        resolve();
      }
    });
    await new Promise((resolve) => setTimeout(resolve, DICTATION_SETTLE_MS));
    if (!isDictating()) {
      return;
    }
  }
};

const getChatGenerator = () =>
  getNoteGenerationAvailable(getAppState()) ? getGenerateTextRepo().repo : null;

let localNotePipeline: LocalNotePipeline | null = null;

const getLocalNotePipeline = (): LocalNotePipeline => {
  localNotePipeline ??= new LocalNotePipeline({
    store: noteStore,
    repo: getNoteRepo(),
    audio: getMeetingAudioRepo(),
    transcribe: async ({ samples, sampleRate }) => {
      const state = getAppState();
      // Voquill cloud transcription out of words would fall back to
      // on-device Whisper for dictation; a meeting stops instead, so it is
      // never processed somewhere the user did not choose.
      if (getLocalNoteTranscriptionBlocked(state)) {
        throw dictationWordsExceeded();
      }
      // Same per-request bound as dictation recovery: hosted providers get
      // a timeout, local and self-hosted inference none.
      const transcriptionPrefs = getTranscriptionPrefs(state);
      if (
        getLocalNoteTranscribesWithVoquill(state) &&
        transcriptionPrefs.mode !== "cloud"
      ) {
        // Not signed in, or the plan has not loaded: retry later.
        throw new Error("Voquill cloud transcription is not available now");
      }
      const timeout = getTranscriptionAttemptTimeout(transcriptionPrefs);
      const { rawTranscript } = await runWithAttemptTimeout(
        (signal) =>
          transcribeAudio({ samples, sampleRate, transcriptionPrefs, signal }),
        timeout ? timeout((samples.length / sampleRate) * 1000) : null,
      ).catch((error: unknown) => {
        if (String(error).includes(VOQUILL_WORD_QUOTA_ERROR)) {
          throw dictationWordsExceeded();
        }
        throw error;
      });
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
    getProcessedWith: () => getLocalNoteProcessedWith(getAppState()),
    getTranscriptionWordBudget: () =>
      getLocalNoteTranscriptionWordBudget(getAppState()),
    getChunkLimits: () =>
      getTranscriptionPrefs(getAppState()).mode === "local"
        ? LOCAL_WHISPER_NOTE_CHUNK_LIMITS
        : DEFAULT_NOTE_CHUNK_LIMITS,
    yieldToDictation,
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
    api: (ownerUserId) => getCloudNoteRepo().forOwner(ownerUserId),
    audio: getMeetingAudioRepo(),
    connectivity,
    sleep: sleepUntilOnlineOr,
    now: () => Date.now(),
    getCloudNotesUserId: () => getCloudNotesUserId(getAppState()),
    isNoteOpen: (noteId) => getAppState().notes.openNoteId === noteId,
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
    yieldToDictation,
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
