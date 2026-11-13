import type { IntlShape } from "react-intl";

export type NoteErrorDescription = {
  title: string;
  body: string;
  /** The way forward is the plan upgrade dialog. */
  upgrade: boolean;
  /** Retrying can help (otherwise the user has to change something first). */
  retryable: boolean;
};

/** Plain-language text for a note or request error code, local or cloud. */
export const describeNoteError = (
  intl: IntlShape,
  code: string | undefined,
): NoteErrorDescription => {
  const describe = (
    title: string,
    body: string,
    options: Partial<Pick<NoteErrorDescription, "upgrade" | "retryable">> = {},
  ): NoteErrorDescription => ({
    title,
    body,
    upgrade: options.upgrade ?? false,
    retryable: options.retryable ?? true,
  });

  switch (code) {
    case "word_quota_exceeded":
      return describe(
        intl.formatMessage({ defaultMessage: "You're out of free words" }),
        intl.formatMessage({
          defaultMessage:
            "Upgrade to Pro to turn this meeting into notes, then retry.",
        }),
        { upgrade: true },
      );
    case "audio_quota_exceeded":
      return describe(
        intl.formatMessage({ defaultMessage: "Meeting allowance reached" }),
        intl.formatMessage({
          defaultMessage:
            "Your plan includes a rolling 30-day allowance of meeting audio. Retry once older meetings fall out of the window.",
        }),
      );
    case "member_not_found":
      return describe(
        intl.formatMessage({
          defaultMessage: "Your Voquill account isn't set up yet",
        }),
        intl.formatMessage({
          defaultMessage: "Finish signing in to Voquill, then retry.",
        }),
      );
    case "too_many_processing_notes":
      return describe(
        intl.formatMessage({ defaultMessage: "Other meetings are processing" }),
        intl.formatMessage({
          defaultMessage:
            "Voquill processes a few meetings at a time. Retry in a few minutes.",
        }),
      );
    case "regenerate_cooldown":
      return describe(
        intl.formatMessage({ defaultMessage: "Notes were just regenerated" }),
        intl.formatMessage({
          defaultMessage: "Wait a few minutes before regenerating again.",
        }),
      );
    case "segment_too_large":
    case "segment_too_long":
    case "too_many_segments":
    case "note_too_long":
      return describe(
        intl.formatMessage({
          defaultMessage: "This meeting is too long for Voquill cloud",
        }),
        intl.formatMessage({
          defaultMessage:
            "Meetings can be up to 8 hours, in parts of up to 4 hours. Remove a part or keep it as a local recording.",
        }),
        { retryable: false },
      );
    case "unsupported_audio":
    case "upload_rejected":
      return describe(
        intl.formatMessage({
          defaultMessage: "The recording couldn't be read",
        }),
        intl.formatMessage({
          defaultMessage:
            "Retry. If it keeps failing, this part of the recording may be damaged.",
        }),
      );
    case "audio_missing":
      return describe(
        intl.formatMessage({
          defaultMessage: "The recording couldn't be found",
        }),
        intl.formatMessage({
          defaultMessage:
            "The audio for part of this meeting is no longer on this device.",
        }),
        { retryable: false },
      );
    case "transcription_failed":
      return describe(
        intl.formatMessage({
          defaultMessage: "Transcription didn't finish",
        }),
        intl.formatMessage({
          defaultMessage:
            "Check your internet connection and your transcription settings, then retry. Finished parts won't be redone.",
        }),
      );
    case "generation_failed":
      return describe(
        intl.formatMessage({
          defaultMessage: "Writing the notes didn't finish",
        }),
        intl.formatMessage({
          defaultMessage:
            "Check your internet connection and your AI post-processing settings, then retry.",
        }),
      );
    case "network_unavailable":
      return describe(
        intl.formatMessage({ defaultMessage: "Couldn't reach Voquill" }),
        intl.formatMessage({
          defaultMessage: "Check your internet connection, then retry.",
        }),
      );
    default:
      return describe(
        intl.formatMessage({ defaultMessage: "Processing didn't finish" }),
        intl.formatMessage({ defaultMessage: "Retry to continue." }),
      );
  }
};
