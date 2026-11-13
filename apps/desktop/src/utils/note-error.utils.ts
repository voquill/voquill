import type { NoteError } from "@voquill/types";
import {
  defineMessages,
  type IntlShape,
  type MessageDescriptor,
} from "react-intl";

export type NoteErrorDescription = {
  title: string;
  body: string;
  /** The way forward is the plan upgrade dialog. */
  upgrade: boolean;
  /** Retrying can help (otherwise the user has to change something first). */
  retryable: boolean;
  /** When the blocking limit frees up, if the server said. */
  availableAt: Date | null;
  /** Say the recording is kept (the body doesn't already say what happened to it). */
  audioSafe: boolean;
};

type NoteErrorEntry = {
  title: MessageDescriptor;
  body: MessageDescriptor;
  upgrade?: boolean;
  retryable?: boolean;
  /** The body itself says what happened to the recording. */
  explainsAudio?: boolean;
};

const messages = defineMessages({
  audioQuotaTitle: { defaultMessage: "Meeting allowance reached" },
  audioQuotaBody: {
    defaultMessage:
      "Your plan includes a rolling 30-day allowance of meeting audio. Retry once older meetings fall out of the window, or upgrade for more.",
  },
  askLimitTitle: { defaultMessage: "Daily Ask limit reached" },
  askLimitBody: {
    defaultMessage: "You've asked the most questions allowed for today.",
  },
  memberTitle: { defaultMessage: "Your Voquill account isn't set up yet" },
  memberBody: { defaultMessage: "Finish signing in to Voquill, then retry." },
  processingLimitTitle: { defaultMessage: "Waiting for your other notes" },
  processingLimitBody: {
    defaultMessage:
      "Your plan processes a limited number of notes at a time. This one starts when another finishes.",
  },
  pendingUploadsTitle: {
    defaultMessage: "Too many recordings are waiting to upload",
  },
  pendingUploadsBody: {
    defaultMessage:
      "Finish or delete other notes that are waiting to upload, then retry.",
  },
  uploadSessionsTitle: {
    defaultMessage: "Daily upload limit reached",
  },
  uploadSessionsBody: {
    defaultMessage:
      "Voquill accepts a limited number of recording uploads per day. This one continues when the limit resets.",
  },
  deletedTitle: { defaultMessage: "This note was deleted on another device" },
  deletedBody: {
    defaultMessage:
      "Its recording is kept here because it was never uploaded. Delete this note once you no longer need the audio.",
  },
  unavailableTitle: {
    defaultMessage: "Voquill Notes is unavailable right now",
  },
  unavailableBody: { defaultMessage: "Retry in a little while." },
  cooldownTitle: { defaultMessage: "Notes were just regenerated" },
  cooldownBody: {
    defaultMessage: "Wait a few minutes before regenerating again.",
  },
  tooLongTitle: {
    defaultMessage: "This meeting is too long for Voquill cloud",
  },
  tooLongBody: {
    defaultMessage:
      "Meetings can be up to 8 hours, in parts of up to 4 hours. Remove a part or keep it as a local recording.",
  },
  tooLargeTitle: { defaultMessage: "Part of this recording is too large" },
  tooLargeBody: {
    defaultMessage:
      "Your plan accepts smaller recording parts. Remove this part, or upgrade to Pro for larger parts.",
  },
  tooManyPartsTitle: { defaultMessage: "This note has too many parts" },
  tooManyPartsBody: {
    defaultMessage:
      "A note can have up to 50 recorded parts. Start a new note to keep recording.",
  },
  unreadableTitle: { defaultMessage: "The recording couldn't be read" },
  unreadableBody: {
    defaultMessage:
      "Retry. If it keeps failing, this part of the recording may be damaged.",
  },
  missingTitle: { defaultMessage: "The recording couldn't be found" },
  missingBody: {
    defaultMessage:
      "The audio for part of this meeting is no longer on this device.",
  },
  transcriptionTitle: { defaultMessage: "Transcription didn't finish" },
  transcriptionBody: {
    defaultMessage:
      "Check your internet connection and your transcription settings, then retry. Finished parts won't be redone.",
  },
  generationTitle: { defaultMessage: "Writing the notes didn't finish" },
  generationBody: {
    defaultMessage:
      "Check your internet connection and your AI post-processing settings, then retry.",
  },
  networkTitle: { defaultMessage: "Couldn't reach Voquill" },
  networkBody: {
    defaultMessage: "Check your internet connection, then retry.",
  },
  interruptedTitle: { defaultMessage: "Recording stopped unexpectedly" },
  interruptedBody: {
    defaultMessage:
      "The microphone stopped delivering audio or Voquill closed. Everything recorded until then is saved. Resume to keep recording, or Stop to write the notes.",
  },
  writeFailedTitle: { defaultMessage: "Recording stopped: disk error" },
  writeFailedBody: {
    defaultMessage:
      "Voquill couldn't save more audio, for example because the disk is full. Everything recorded until then is saved. Free up space, then Resume or Stop.",
  },
  lengthLimitTitle: { defaultMessage: "This meeting reached its length limit" },
  lengthLimitBody: {
    defaultMessage:
      "A note can hold up to 8 hours of recording. Everything recorded is saved: Stop to write the notes, then start a new note to keep recording.",
  },
  dictationWordsTitle: {
    defaultMessage: "Not enough Voquill words for this meeting",
  },
  dictationWordsBody: {
    defaultMessage:
      "This meeting is kept on this device and its recording is safe. It's transcribed with your Voquill dictation words, and there aren't enough left. Switch post-processing to Voquill cloud to use your meeting allowance instead, upgrade, or retry when your words reset.",
  },
  recoveredAudioTitle: { defaultMessage: "Recovered audio was added" },
  recoveredAudioBody: {
    defaultMessage:
      "Part of this meeting was found on this device after Voquill closed unexpectedly. Its recording is safe. Process the note again to include it.",
  },
  genericTitle: { defaultMessage: "Processing didn't finish" },
  genericBody: { defaultMessage: "Retry to continue." },
});

/** Every local and server error code the notes UI explains; unknown codes get the generic text. */
const NOTE_ERRORS: Record<string, NoteErrorEntry> = {
  audio_quota_exceeded: {
    title: messages.audioQuotaTitle,
    body: messages.audioQuotaBody,
    upgrade: true,
  },
  ask_limit_exceeded: {
    title: messages.askLimitTitle,
    body: messages.askLimitBody,
  },
  member_not_found: { title: messages.memberTitle, body: messages.memberBody },
  too_many_processing: {
    title: messages.processingLimitTitle,
    body: messages.processingLimitBody,
  },
  too_many_pending_uploads: {
    title: messages.pendingUploadsTitle,
    body: messages.pendingUploadsBody,
  },
  too_many_upload_sessions: {
    title: messages.uploadSessionsTitle,
    body: messages.uploadSessionsBody,
  },
  note_deleted: {
    title: messages.deletedTitle,
    body: messages.deletedBody,
    retryable: false,
    explainsAudio: true,
  },
  notes_unavailable: {
    title: messages.unavailableTitle,
    body: messages.unavailableBody,
  },
  regenerate_cooldown: {
    title: messages.cooldownTitle,
    body: messages.cooldownBody,
  },
  segment_too_long: {
    title: messages.tooLongTitle,
    body: messages.tooLongBody,
    retryable: false,
  },
  note_too_long: {
    title: messages.tooLongTitle,
    body: messages.tooLongBody,
    retryable: false,
  },
  segment_too_large: {
    title: messages.tooLargeTitle,
    body: messages.tooLargeBody,
    upgrade: true,
    retryable: false,
  },
  too_many_segments: {
    title: messages.tooManyPartsTitle,
    body: messages.tooManyPartsBody,
    retryable: false,
  },
  unsupported_audio: {
    title: messages.unreadableTitle,
    body: messages.unreadableBody,
  },
  upload_rejected: {
    title: messages.unreadableTitle,
    body: messages.unreadableBody,
  },
  audio_missing: {
    title: messages.missingTitle,
    body: messages.missingBody,
    retryable: false,
    explainsAudio: true,
  },
  transcription_failed: {
    title: messages.transcriptionTitle,
    body: messages.transcriptionBody,
  },
  generation_failed: {
    title: messages.generationTitle,
    body: messages.generationBody,
  },
  network_unavailable: {
    title: messages.networkTitle,
    body: messages.networkBody,
  },
  capture_interrupted: {
    title: messages.interruptedTitle,
    body: messages.interruptedBody,
    explainsAudio: true,
  },
  capture_write_failed: {
    title: messages.writeFailedTitle,
    body: messages.writeFailedBody,
    explainsAudio: true,
  },
  dictation_words_exceeded: {
    title: messages.dictationWordsTitle,
    body: messages.dictationWordsBody,
    upgrade: true,
    explainsAudio: true,
  },
  recovered_audio: {
    title: messages.recoveredAudioTitle,
    body: messages.recoveredAudioBody,
    explainsAudio: true,
  },
  note_length_limit: {
    title: messages.lengthLimitTitle,
    body: messages.lengthLimitBody,
    retryable: false,
    explainsAudio: true,
  },
};

const GENERIC_ERROR: NoteErrorEntry = {
  title: messages.genericTitle,
  body: messages.genericBody,
};

/**
 * When the refused call could go through, from the error details
 * (docs/notes.md, third revision): `availableAt` (allowance, cooldown),
 * `resetsAt` (daily caps), else `retryAfterSeconds`.
 */
export const getNoteErrorAvailableAt = (
  details: Record<string, unknown> | null | undefined,
  now = Date.now(),
): Date | null => {
  if (!details) return null;
  for (const key of ["availableAt", "resetsAt"]) {
    const value = details[key];
    const time = typeof value === "string" ? Date.parse(value) : NaN;
    if (Number.isFinite(time) && time > now) {
      return new Date(time);
    }
  }
  if (typeof details.retryAfterSeconds === "number") {
    return new Date(now + details.retryAfterSeconds * 1000);
  }
  return null;
};

/** Plain-language text for a note or request error, local or cloud. */
export const describeNoteError = (
  intl: IntlShape,
  error: Pick<NoteError, "code" | "details"> | string | null | undefined,
): NoteErrorDescription => {
  const code = typeof error === "string" ? error : error?.code;
  const details = typeof error === "string" ? null : error?.details;
  const entry = (code && NOTE_ERRORS[code]) || GENERIC_ERROR;
  return {
    title: intl.formatMessage(entry.title),
    body: intl.formatMessage(entry.body),
    upgrade: entry.upgrade ?? false,
    retryable: entry.retryable ?? true,
    availableAt: getNoteErrorAvailableAt(details),
    audioSafe: !entry.explainsAudio,
  };
};
