import type {
  DictationTranscriptReconcilerSnapshot as SharedTranscriptReconcilerSnapshot,
  DictationTranscriptUpdate as SharedTranscriptUpdate,
} from "@voquill/types";

export type TranscriptUpdate = SharedTranscriptUpdate;

export type TranscriptReconcilerSnapshot = SharedTranscriptReconcilerSnapshot;

export type TranscriptReconciler = {
  applyPartial(update: TranscriptUpdate): string;
  applyFinal(update: TranscriptUpdate): string;
  reset(): void;
  getAuthoritativeTranscript(): string;
  getSnapshot(): TranscriptReconcilerSnapshot;
};

const sanitizeTranscript = (text: string): string => text.trim();

export const createTranscriptReconciler = (): TranscriptReconciler => {
  let partialText = "";
  let finalText: string | null = null;

  const getAuthoritativeTranscript = (): string => finalText ?? partialText;

  return {
    applyPartial: ({ text }) => {
      if (finalText !== null) {
        return getAuthoritativeTranscript();
      }

      partialText = sanitizeTranscript(text);
      return getAuthoritativeTranscript();
    },
    applyFinal: ({ text }) => {
      finalText = sanitizeTranscript(text);
      partialText = finalText;
      return getAuthoritativeTranscript();
    },
    reset: () => {
      partialText = "";
      finalText = null;
    },
    getAuthoritativeTranscript,
    getSnapshot: () => ({
      partialText,
      finalText,
      authoritativeText: getAuthoritativeTranscript(),
      isAuthoritative: finalText !== null,
      isFinal: finalText !== null,
    }),
  };
};
