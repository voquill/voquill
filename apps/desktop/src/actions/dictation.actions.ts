import type { AppTarget } from "@voquill/types";
import { getIntl } from "../i18n/intl";
import { getAppState } from "../store";
import type { TextFieldInfo } from "../types/accessibility.types";
import type {
  StopRecordingResponse,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import { getLogger } from "../utils/log.utils";
import type { DictationNotice, DictationRun } from "./dictation-runner";
import { refreshMember } from "./member.actions";
import {
  type FailedTranscriptionStorage,
  storeFailedTranscription,
  storeTranscription,
} from "./transcribe.actions";

export type FinishDictationInput = {
  run: DictationRun;
  audio: StopRecordingResponse;
  toneId: string | null;
  a11yInfo: TextFieldInfo | null;
  appTarget: AppTarget | null;
};

export type FinishDictationOutcome = {
  shouldContinue: boolean;
  notice?: DictationNotice;
};

const describeFailure = (
  result: TranscriptionSessionResult,
): Pick<DictationNotice, "title" | "action"> & { reason: string } => {
  const intl = getIntl();
  if (result.failureCode === "quota_exceeded") {
    return {
      title: intl.formatMessage({ defaultMessage: "Word limit reached" }),
      reason: intl.formatMessage({
        defaultMessage: "You've used all your free words for today.",
      }),
      action: "upgrade",
    };
  }
  if (result.failureCode === "provider_unsupported") {
    return {
      reason: intl.formatMessage({
        defaultMessage:
          "Your transcription provider can't transcribe audio. Choose another one in Settings.",
      }),
      action: "surface_window",
    };
  }
  if (result.failureCode === "auth_failed") {
    return {
      reason: intl.formatMessage({
        defaultMessage:
          "Couldn't transcribe your dictation because you are signed out. Sign in again to continue.",
      }),
      action: "surface_window",
    };
  }
  return {
    reason: intl.formatMessage({
      defaultMessage: "Couldn't transcribe your dictation.",
    }),
  };
};

const describeStorage = (
  storage: FailedTranscriptionStorage | null,
): string | null => {
  const intl = getIntl();
  switch (storage) {
    case "saved":
      return intl.formatMessage({
        defaultMessage:
          "Your audio is saved in History, where you can retry it.",
      });
    case "incognito":
      return intl.formatMessage({
        defaultMessage: "It was not saved because incognito mode is on.",
      });
    default:
      return null;
  }
};

const getFailureNotice = async (
  run: DictationRun,
  audio: StopRecordingResponse,
  result: TranscriptionSessionResult,
): Promise<DictationNotice> => {
  const storage = run.strategy.shouldStoreTranscript()
    ? await storeFailedTranscription(audio, result)
    : null;
  const { reason, title, action } = describeFailure(result);
  return {
    title,
    body: [reason, describeStorage(storage)].filter(Boolean).join(" "),
    action,
  };
};

/**
 * Turns a stopped recording into delivered output: transcribe (with
 * recovery), post-process, paste and store exactly once, or persist the
 * audio as a failed History entry when it cannot be transcribed. Every side
 * effect is gated on `run` still being active, so a cancelled dictation
 * delivers nothing.
 */
export const finishDictation = async ({
  run,
  audio,
  toneId,
  a11yInfo,
  appTarget,
}: FinishDictationInput): Promise<FinishDictationOutcome> => {
  const { session, strategy } = run;
  const transcribeResult = await session.finalize(audio, { toneId, a11yInfo });
  const rawTranscript = transcribeResult.rawTranscript;
  getLogger().verbose(
    `Transcription result (${session.name}): rawTranscript=${rawTranscript ? `${rawTranscript.length} chars` : "empty"}, recovered=${!!transcribeResult.recovered}, failure=${transcribeResult.failureReason ?? "none"}, toneId=${toneId ?? "none"}, app=${appTarget?.name ?? "unknown"}`,
  );

  if (!run.isActive) {
    getLogger().info("Dictation was cancelled while transcribing; discarding");
    return { shouldContinue: false };
  }

  if (transcribeResult.failureReason) {
    getLogger().error(
      `Transcription failed after recovery: ${transcribeResult.failureReason}`,
    );
    return {
      shouldContinue: false,
      notice: await getFailureNotice(run, audio, transcribeResult),
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
    signal: run.signal,
  });
  getLogger().verbose(
    `Post-processing complete: transcript=${result.transcript ? `${result.transcript.length} chars` : "empty"}, warnings=${result.postProcessWarnings.length}`,
  );

  if (!run.isActive) {
    getLogger().info(
      "Dictation was cancelled while post-processing; discarding",
    );
    return { shouldContinue: false };
  }

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
