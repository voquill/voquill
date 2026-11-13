import { Transcription } from "@voquill/types";
import { countWords, getRec } from "@voquill/utilities";
import { getTranscriptionRepo } from "../repos";
import { getAppState, produceAppState } from "../store";
import {
  applyReplacements,
  applySymbolConversions,
} from "../utils/string.utils";
import {
  FAILED_TRANSCRIPT_PLACEHOLDER,
  postProcessTranscript,
  transcribeAudio,
} from "./transcribe.actions";
import { addWordsToCurrentUser } from "./user.actions";

export const openTranscriptionDetailsDialog = (transcriptionId: string) => {
  produceAppState((draft) => {
    draft.transcriptions.detailsDialogTranscriptionId = transcriptionId;
    draft.transcriptions.detailsDialogOpen = true;
  });
};

export const closeTranscriptionDetailsDialog = () => {
  produceAppState((draft) => {
    draft.transcriptions.detailsDialogOpen = false;
  });
};

export const openRetranscribeDialog = (transcriptionId: string) => {
  produceAppState((draft) => {
    draft.transcriptions.retranscribeDialogTranscriptionId = transcriptionId;
    draft.transcriptions.retranscribeDialogOpen = true;
  });
};

export const closeRetranscribeDialog = () => {
  produceAppState((draft) => {
    draft.transcriptions.retranscribeDialogOpen = false;
  });
};

export const openFlagTranscriptionDialog = (transcriptionId: string) => {
  produceAppState((draft) => {
    draft.transcriptions.flagDialogTranscriptionId = transcriptionId;
    draft.transcriptions.flagDialogOpen = true;
  });
};

export const closeFlagTranscriptionDialog = () => {
  produceAppState((draft) => {
    draft.transcriptions.flagDialogOpen = false;
  });
};

type RetranscribeTranscriptionParams = {
  transcriptionId: string;
  toneId?: string | null;
  languageCode?: string | null;
};

export const retranscribeTranscription = async ({
  transcriptionId,
  toneId,
  languageCode,
}: RetranscribeTranscriptionParams): Promise<void> => {
  const state = getAppState();
  const transcription = getRec(state.transcriptionById, transcriptionId);

  if (!transcription) {
    throw new Error("Transcription not found.");
  }

  const repo = getTranscriptionRepo();
  const audioData = await repo.loadTranscriptionAudio(transcriptionId);

  const transcribeResult = await transcribeAudio({
    samples: audioData.samples,
    sampleRate: audioData.sampleRate,
    dictationLanguage: languageCode ?? undefined,
  });

  const rawTranscript = transcribeResult.rawTranscript;

  const replacementRules = Object.values(state.termById)
    .filter((term) => term.isReplacement)
    .map((term) => ({
      sourceValue: term.sourceValue,
      destinationValue: term.destinationValue,
    }));

  const afterReplacements = applyReplacements(rawTranscript, replacementRules);
  const sanitizedTranscript = applySymbolConversions(afterReplacements);

  const postProcessResult = await postProcessTranscript({
    rawTranscript: sanitizedTranscript,
    toneId: toneId ?? null,
    dictationLanguage: languageCode ?? undefined,
  });

  const finalTranscript = postProcessResult.transcript;

  const warnings = [
    ...transcribeResult.warnings,
    ...postProcessResult.warnings,
  ];
  const metadata = {
    ...transcribeResult.metadata,
    ...postProcessResult.metadata,
  };

  if (!finalTranscript) {
    throw new Error("Retranscription produced no text.");
  }

  const updatedPayload: Transcription = {
    ...transcription,
    transcript: finalTranscript,
    sanitizedTranscript,
    modelSize: metadata?.modelSize ?? null,
    inferenceDevice: metadata?.inferenceDevice ?? null,
    rawTranscript: rawTranscript ?? finalTranscript,
    transcriptionPrompt: metadata?.transcriptionPrompt ?? null,
    postProcessPrompt: metadata?.postProcessPrompt ?? null,
    transcriptionApiKeyId: metadata?.transcriptionApiKeyId ?? null,
    postProcessApiKeyId: metadata?.postProcessApiKeyId ?? null,
    transcriptionMode: metadata?.transcriptionMode ?? null,
    postProcessMode: metadata?.postProcessMode ?? null,
    postProcessDevice: metadata?.postProcessDevice ?? null,
    warnings: warnings.length > 0 ? warnings : null,
  };

  const updated = await repo.updateTranscription(updatedPayload);

  produceAppState((draft) => {
    draft.transcriptionById[transcriptionId] = updated;
  });

  // A failed dictation never counted its words, so its first successful retry does.
  if (transcription.transcript === FAILED_TRANSCRIPT_PLACEHOLDER) {
    await addWordsToCurrentUser(countWords(finalTranscript)).catch((error) =>
      console.error("Failed to update usage metrics", error),
    );
  }
};
