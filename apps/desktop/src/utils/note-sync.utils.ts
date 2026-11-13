import type { Note, NoteSegment } from "@voquill/types";
import {
  fromServerSegment,
  toClientNoteStatus,
  toLocalSegmentId,
  type ServerNote,
  type ServerNoteSegment,
} from "../repos/cloud-note.repo";
import type { NoteSearchResult } from "./note-search.utils";
import { syncNoteStatus } from "./note-state.utils";

/**
 * The local copy of a cloud note after seeing the server's version. The
 * server wins for everything it generates; the user's own edits win while
 * they are not yet confirmed; work in progress on this device keeps its
 * status.
 */
export const mergeServerNote = (
  local: Note | null,
  server: ServerNote,
  ownerUserId: string,
): Note => {
  const unsynced = local?.cloud?.unsyncedFields ?? [];
  const keepTitle = local !== null && unsynced.includes("title");
  const keepPersonalNotes =
    local !== null && unsynced.includes("personalNotes");
  const status = syncNoteStatus(
    local?.status ?? null,
    toClientNoteStatus(server.status),
  );
  const serverIsAuthoritative = status === toClientNoteStatus(server.status);
  return {
    id: server.id,
    storage: "cloud",
    status,
    title: keepTitle ? local.title : server.title,
    titleSource: keepTitle ? local.titleSource : server.titleSource,
    error: serverIsAuthoritative ? server.error : (local?.error ?? null),
    source: server.source,
    personalNotes: keepPersonalNotes
      ? local.personalNotes
      : server.personalNotes,
    generatedNotes: server.generatedNotes,
    durationMs: serverIsAuthoritative
      ? server.durationMs
      : Math.max(server.durationMs, local?.durationMs ?? 0),
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    cloud: {
      ownerUserId,
      onServer: true,
      unsyncedFields: unsynced,
      processRequestedAt: local?.cloud?.processRequestedAt ?? null,
      serverUpdatedAt: server.updatedAt,
      fetchedUpdatedAt: local?.cloud?.fetchedUpdatedAt ?? null,
    },
  };
};

/**
 * Server segments with this device's audio and upload state kept; local
 * segments the server does not know yet (not uploaded) stay as they are.
 */
export const mergeServerSegments = (
  noteId: string,
  local: NoteSegment[],
  server: ServerNoteSegment[],
): NoteSegment[] => {
  const localById = new Map(local.map((segment) => [segment.id, segment]));
  const merged = server.map((segment): NoteSegment => {
    const mine = localById.get(toLocalSegmentId(noteId, segment.id));
    const fromServer = fromServerSegment(noteId, segment);
    return {
      ...fromServer,
      transcript: fromServer.transcript ?? mine?.transcript ?? null,
      audioPath: mine?.audioPath ?? null,
      upload: mine?.upload ?? null,
    };
  });
  const serverIds = new Set(merged.map((segment) => segment.id));
  return [
    ...merged,
    ...local.filter((segment) => !serverIds.has(segment.id)),
  ].sort((left, right) => left.index - right.index);
};

/**
 * Whether a cloud note the server no longer lists may be removed from this
 * device: never while it has audio here that the server has not transcribed,
 * never while it is recording or waiting to be sent, and never if it has
 * not reached the server yet.
 */
export const canRemoveMissingCloudNote = (
  note: Note,
  segments: NoteSegment[],
): boolean =>
  note.cloud?.onServer === true &&
  note.status !== "recording" &&
  note.status !== "pending" &&
  segments.every((segment) => segment.audioPath === null);

/**
 * Server (hybrid) results first in their order, then local text matches the
 * server did not return (local notes, or cloud notes it missed).
 */
export const mergeNoteSearchResults = (
  remote: NoteSearchResult[],
  local: NoteSearchResult[],
): NoteSearchResult[] => {
  const seen = new Set(remote.map((result) => result.note.id));
  return [...remote, ...local.filter((result) => !seen.has(result.note.id))];
};

/** The cached segments are older than the note the server last reported. */
export const needsFullNoteFetch = (note: Note): boolean =>
  note.cloud !== null &&
  note.cloud.onServer &&
  (note.cloud.fetchedUpdatedAt === null ||
    note.cloud.fetchedUpdatedAt !== note.cloud.serverUpdatedAt);
