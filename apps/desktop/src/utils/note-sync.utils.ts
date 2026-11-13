import type { Note, NoteSegment } from "@voquill/types";
import {
  fromServerSegment,
  toClientNoteStatus,
  toLocalSegmentId,
  type ServerNote,
  type ServerNoteSegment,
} from "../repos/cloud-note.repo";
import type { NoteSearchResult } from "./note-search.utils";
import { isEqual } from "lodash-es";
import { syncNoteStatus } from "./note-state.utils";

/**
 * The server's `updatedAt` moves forward with every change, so a version
 * older than one this device already applied (a GET that started before a
 * PATCH returned) carries nothing new.
 */
export const isStaleServerNote = (local: Note, server: ServerNote): boolean => {
  const known = local.cloud?.serverUpdatedAt;
  return Boolean(known) && Date.parse(server.updatedAt) < Date.parse(known!);
};

/**
 * Applies the server's version to a cloud note as it is now, field by
 * field: the server wins for what it generates, the user's unconfirmed
 * edits win, and work in progress on this device keeps its status. Returns
 * false (nothing changed) for a stale version.
 */
export const applyServerNote = (note: Note, server: ServerNote): boolean => {
  if (!note.cloud || isStaleServerNote(note, server)) {
    return false;
  }
  const unsynced = note.cloud.unsyncedFields;
  const serverStatus = toClientNoteStatus(server.status);
  const status = syncNoteStatus(note.status, serverStatus);
  const serverIsAuthoritative = status === serverStatus;
  if (!unsynced.includes("title")) {
    note.title = server.title;
    note.titleSource = server.titleSource;
  }
  if (!unsynced.includes("personalNotes")) {
    note.personalNotes = server.personalNotes;
  }
  if (serverIsAuthoritative) {
    note.error = server.error;
    note.durationMs = server.durationMs;
  } else {
    note.durationMs = Math.max(server.durationMs, note.durationMs);
  }
  note.status = status;
  note.source = server.source;
  note.generatedNotes = server.generatedNotes;
  note.createdAt = server.createdAt;
  note.updatedAt = server.updatedAt;
  note.cloud.onServer = true;
  note.cloud.serverUpdatedAt = server.updatedAt;
  return true;
};

/** A cloud note this device has not seen (recorded elsewhere). */
export const noteFromServer = (
  server: ServerNote,
  ownerUserId: string,
): Note => {
  const note: Note = {
    id: server.id,
    storage: "cloud",
    status: toClientNoteStatus(server.status),
    title: server.title,
    titleSource: server.titleSource,
    error: server.error,
    source: server.source,
    personalNotes: server.personalNotes,
    generatedNotes: server.generatedNotes,
    durationMs: server.durationMs,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    processedWith: null,
    cloud: {
      ownerUserId,
      onServer: true,
      unsyncedFields: [],
      processRequestedAt: null,
      serverUpdatedAt: server.updatedAt,
      fetchedUpdatedAt: null,
    },
  };
  return note;
};

/** Whether applying `server` would change the stored note (skips no-op writes). */
export const serverNoteChanges = (local: Note, server: ServerNote): boolean => {
  const next = structuredClone(local);
  return applyServerNote(next, server) && !isEqual(next, local);
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
