import type { NoteStatus } from "@voquill/types";

/**
 * The note lifecycle. Every status change goes through `transitionNote`;
 * `recoverNoteStatus` re-enters the machine after a restart or crash.
 */
export type NoteEvent =
  | "pause"
  | "resume"
  | "interrupt"
  | "finish"
  | "start-processing"
  | "succeed"
  | "fail"
  | "retry"
  | "regenerate";

const NOTE_TRANSITIONS: Record<
  NoteStatus,
  Partial<Record<NoteEvent, NoteStatus>>
> = {
  recording: { pause: "paused", interrupt: "paused", finish: "pending" },
  paused: { resume: "recording", finish: "pending" },
  pending: { "start-processing": "processing", fail: "failed" },
  processing: { succeed: "ready", fail: "failed" },
  ready: { resume: "recording", regenerate: "pending", retry: "pending" },
  failed: { retry: "pending" },
};

export const canTransitionNote = (
  status: NoteStatus,
  event: NoteEvent,
): boolean => NOTE_TRANSITIONS[status][event] !== undefined;

export const transitionNote = (
  status: NoteStatus,
  event: NoteEvent,
): NoteStatus => {
  const next = NOTE_TRANSITIONS[status][event];
  if (!next) {
    throw new Error(`Invalid note transition: ${status} --${event}-->`);
  }
  return next;
};

/**
 * The status a stored note resumes in when the app starts. Capture never
 * survives the app, so a `recording` note is paused unless this device is
 * still capturing it (the web view reloaded while the native layer kept
 * recording). Interrupted processing is queued again; the pipeline resumes
 * from its persisted progress.
 */
export const recoverNoteStatus = (
  status: NoteStatus,
  isStillCapturing: boolean,
): NoteStatus => {
  switch (status) {
    case "recording":
      return isStillCapturing ? "recording" : "paused";
    case "processing":
      return "pending";
    default:
      return status;
  }
};

/**
 * The status of a cloud note after the server reported `serverStatus`
 * (already mapped to a client status). Work happening on this device
 * (recording, or `pending`: uploads and requests not yet accepted) keeps its
 * local status; a server draft keeps whatever the device knows (a paused or
 * locally failed note); otherwise the server is authoritative.
 */
export const syncNoteStatus = (
  localStatus: NoteStatus | null,
  serverStatus: NoteStatus,
): NoteStatus => {
  if (localStatus === "recording" || localStatus === "pending") {
    return localStatus;
  }
  if (serverStatus === "paused" && localStatus) {
    return localStatus;
  }
  return serverStatus;
};
