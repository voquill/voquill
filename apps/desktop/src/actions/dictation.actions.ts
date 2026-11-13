import type { AppTarget } from "@voquill/types";
import { getIntl } from "../i18n/intl";
import { getAppState } from "../store";
import type { BaseStrategy } from "../strategies/base.strategy";
import type { TextFieldInfo } from "../types/accessibility.types";
import type {
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import { getLogger } from "../utils/log.utils";
import { refreshMember } from "./member.actions";
import {
  storeFailedTranscription,
  storeTranscription,
} from "./transcribe.actions";

export type FinishDictationInput = {
  session: TranscriptionSession;
  strategy: BaseStrategy;
  audio: StopRecordingResponse;
  toneId: string | null;
  a11yInfo: TextFieldInfo | null;
  appTarget: AppTarget | null;
  /** False once the dictation was cancelled or replaced while it was being transcribed. */
  isCurrent: () => boolean;
};

export type FinishDictationOutcome = {
  shouldContinue: boolean;
  abortMessage?: string;
  /** The dictation was cancelled meanwhile; whoever cancelled it already cleaned up. */
  superseded?: boolean;
};

const getFailedDictationMessage = async (
  strategy: BaseStrategy,
  audio: StopRecordingResponse,
  result: TranscriptionSessionResult,
): Promise<string> => {
  const intl = getIntl();
  if (!strategy.shouldStoreTranscript()) {
    return intl.formatMessage({
      defaultMessage: "Couldn't transcribe your recording.",
    });
  }

  const storage = await storeFailedTranscription(audio, result);
  if (storage === "saved") {
    return intl.formatMessage({
      defaultMessage:
        "Couldn't transcribe your dictation. Your audio is saved in History, where you can retry it.",
    });
  }
  if (storage === "incognito") {
    return intl.formatMessage({
      defaultMessage:
        "Couldn't transcribe your dictation. It was not saved because incognito mode is on.",
    });
  }
  return intl.formatMessage({
    defaultMessage: "Couldn't transcribe your dictation.",
  });
};

/**
 * Turns a stopped recording into delivered output: transcribe (with
 * recovery), post-process, paste and store exactly once, or persist the
 * audio as a failed History entry when it cannot be transcribed.
 */
export const finishDictation = async ({
  session,
  strategy,
  audio,
  toneId,
  a11yInfo,
  appTarget,
  isCurrent,
}: FinishDictationInput): Promise<FinishDictationOutcome> => {
  const transcribeResult = await session.finalize(audio, { toneId, a11yInfo });
  const rawTranscript = transcribeResult.rawTranscript;
  getLogger().verbose(
    `Transcription result (${session.name}): rawTranscript=${rawTranscript ? `${rawTranscript.length} chars` : "empty"}, recovered=${!!transcribeResult.recovered}, failure=${transcribeResult.failureReason ?? "none"}, toneId=${toneId ?? "none"}, app=${appTarget?.name ?? "unknown"}`,
  );

  if (!isCurrent()) {
    getLogger().info("Dictation was cancelled while transcribing; discarding");
    return { shouldContinue: false, superseded: true };
  }

  if (transcribeResult.failureReason) {
    getLogger().error(
      `Transcription failed after recovery: ${transcribeResult.failureReason}`,
    );
    return {
      shouldContinue: false,
      abortMessage: await getFailedDictationMessage(
        strategy,
        audio,
        transcribeResult,
      ),
    };
  }

  if (!rawTranscript) {
    getLogger().warning("finishDictation: no rawTranscript from finalize");
    return { shouldContinue: false };
  }

  if (getAppState().activeRecordingMode === "agent") {
    await strategy.setPhase("idle");
  }

  getLogger().info("Post-processing transcript");
  const result = await strategy.handleTranscript({
    rawTranscript,
    processedTranscript: transcribeResult.processedTranscript,
    serverPostProcessMetadata: transcribeResult.postProcessMetadata,
    toneId,
    a11yInfo,
    currentApp: appTarget,
    loadingToken: null,
    audio,
    transcriptionMetadata: transcribeResult.metadata,
    transcriptionWarnings: transcribeResult.warnings,
    transcriptionRecovered: transcribeResult.recovered ?? false,
  });
  getLogger().verbose(
    `Post-processing complete: transcript=${result.transcript ? `${result.transcript.length} chars` : "empty"}, warnings=${result.postProcessWarnings.length}`,
  );

  if (strategy.shouldStoreTranscript()) {
    getLogger().verbose("Storing transcription");
    storeTranscription({
      audio,
      rawTranscript,
      sanitizedTranscript: result.sanitizedTranscript,
      transcript: result.transcript,
      transcriptionMetadata: transcribeResult.metadata,
      postProcessMetadata: result.postProcessMetadata,
      warnings: [...transcribeResult.warnings, ...result.postProcessWarnings],
      remoteStatus: result.remoteStatus,
      remoteDeviceId: result.remoteDeviceId,
    });
  }

  refreshMember();
  return { shouldContinue: result.shouldContinue };
};
