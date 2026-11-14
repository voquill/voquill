import { getCloudNoteRepo, getNoteRepo } from "../repos";
import { getAppState } from "../store";
import { getLogger } from "../utils/log.utils";
import { getCloudNotesUserId } from "../utils/note.utils";
import {
  applyServerNote,
  canRemoveMissingCloudNote,
  noteFromServer,
  serverNoteChanges,
} from "../utils/note-sync.utils";
import { noteStore } from "./note-store.actions";

const MIN_SYNC_INTERVAL_MS = 15_000;

let lastSyncAt = 0;
let syncInFlight: Promise<void> | null = null;

/**
 * Brings the signed-in account's cloud notes onto this device: sends deletes
 * made offline, upserts every server note (notes from other devices
 * included) and removes local copies the server no longer has, unless they
 * still hold work from this device.
 */
const syncCloudNotesNow = async (ownerUserId: string): Promise<void> => {
  const api = getCloudNoteRepo().forOwner(ownerUserId);
  const repo = getNoteRepo();

  const pendingDeletes = new Set<string>();
  for (const deletion of await repo.listDeletions(ownerUserId)) {
    pendingDeletes.add(deletion.noteId);
    await api.deleteNote(deletion.noteId).catch(() => undefined);
  }

  const serverNotes = await api.listAllNotes();
  if (getCloudNotesUserId(getAppState()) !== ownerUserId) {
    return;
  }

  // A delete is done once the server no longer lists the note.
  const listedIds = new Set(serverNotes.map((note) => note.id));
  for (const noteId of pendingDeletes) {
    if (!listedIds.has(noteId)) {
      await repo.removeDeletion(noteId);
    }
  }

  const serverIds = new Set<string>();
  for (const server of serverNotes) {
    serverIds.add(server.id);
    if (pendingDeletes.has(server.id)) {
      continue;
    }
    const local = noteStore.getNote(server.id);
    if (!local) {
      // Skipped if it was deleted while the list was loading.
      await noteStore.insertNote(noteFromServer(server, ownerUserId), []);
    } else if (
      local.storage === "cloud" &&
      local.cloud?.ownerUserId === ownerUserId &&
      serverNoteChanges(local, server)
    ) {
      await noteStore.updateNote(
        server.id,
        (note) => void applyServerNote(note, server),
        { touch: false },
      );
    }
  }

  for (const note of noteStore.getNotes()) {
    if (
      note.storage !== "cloud" ||
      note.cloud?.ownerUserId !== ownerUserId ||
      serverIds.has(note.id)
    ) {
      continue;
    }
    const segments = await noteStore.loadSegments(note.id);
    if (canRemoveMissingCloudNote(note, segments)) {
      await noteStore.deleteNote(note.id, { deleteAudio: false });
    }
  }
};

export const syncCloudNotes = async ({
  force = false,
}: { force?: boolean } = {}): Promise<void> => {
  const state = getAppState();
  const ownerUserId = getCloudNotesUserId(state);
  if (!ownerUserId || state.notes.loadedForUserId !== ownerUserId) {
    return;
  }
  if (syncInFlight) {
    return syncInFlight;
  }
  if (!force && Date.now() - lastSyncAt < MIN_SYNC_INTERVAL_MS) {
    return;
  }
  lastSyncAt = Date.now();
  syncInFlight = syncCloudNotesNow(ownerUserId)
    .catch((error) => {
      getLogger().warning(`Cloud notes sync failed: ${error}`);
    })
    .finally(() => {
      syncInFlight = null;
    });
  return syncInFlight;
};
