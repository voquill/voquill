import type { NoteStorage } from "@voquill/types";
import { noteStore } from "../actions/note-store.actions";
import { transcribeAudio } from "../actions/transcribe.actions";
import {
  getGenerateTextRepo,
  getMeetingAudioRepo,
  getNoteRepo,
} from "../repos";
import type { AppState } from "../state/app.state";
import { getAppState } from "../store";
import { getNoteGenerationAvailable } from "../utils/note.utils";
import { collectDictionaryEntries } from "../utils/prompt.utils";
import { applyReplacements } from "../utils/string.utils";
import type { BaseNotePipeline } from "./base-note.pipeline";
import { LocalNotePipeline } from "./local-note.pipeline";

/**
 * The storage a new note gets; it never changes afterwards. Stage 2: return
 * "cloud" when signed in to Voquill cloud AND the transcription mode is cloud
 * AND the post-processing mode is cloud.
 */
export const selectNoteStorage = (_state: AppState): NoteStorage => "local";

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
    getTextGenerator: () =>
      getNoteGenerationAvailable(getAppState())
        ? getGenerateTextRepo().repo
        : null,
  });
  return localNotePipeline;
};

export const getNotePipeline = (storage: NoteStorage): BaseNotePipeline => {
  switch (storage) {
    case "local":
      return getLocalNotePipeline();
    case "cloud":
      throw new Error("Cloud notes are not available in this version");
  }
};
