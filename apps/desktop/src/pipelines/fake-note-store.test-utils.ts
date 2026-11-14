import type { Note, NoteSegment } from "@voquill/types";
import type { NoteStore } from "./local-note.pipeline";

/**
 * In-memory note store that behaves like the app's: changes apply to memory
 * at once, and each write resolves only after a pause (the SQLite round
 * trip), so other work can interleave. `log` records writes and deletions
 * in the order they happened.
 */
export class FakeNoteStore implements NoteStore {
  notes = new Map<string, Note>();
  segments = new Map<string, NoteSegment[]>();
  removed = new Set<string>();
  log: string[] = [];
  /** The pause each write takes before it resolves. */
  writeDelay: () => Promise<void> = () =>
    new Promise((resolve) => setTimeout(resolve, 0));

  getNote = (noteId: string) => this.notes.get(noteId) ?? null;
  getNotes = () => [...this.notes.values()];
  getSegments = (noteId: string) => this.segments.get(noteId) ?? [];
  loadSegments = async (noteId: string) => this.getSegments(noteId);

  insertNote = async (note: Note, segments: NoteSegment[]) => {
    if (this.removed.has(note.id) || this.notes.has(note.id)) {
      return false;
    }
    this.notes.set(note.id, structuredClone(note));
    this.segments.set(note.id, structuredClone(segments));
    this.log.push(`insert:${note.id}`);
    await this.writeDelay();
    return true;
  };

  updateNote = async (noteId: string, recipe: (note: Note) => void) => {
    const note = this.notes.get(noteId);
    if (!note) return;
    const before = note.status;
    recipe(note);
    if (note.status !== before) {
      this.log.push(`note:${note.status}`);
    }
    await this.writeDelay();
  };

  updateSegment = async (
    noteId: string,
    segmentId: string,
    recipe: (segment: NoteSegment) => void,
  ) => {
    const segment = this.getSegments(noteId).find((s) => s.id === segmentId);
    if (!segment) return;
    recipe(segment);
    this.log.push(
      `segment:${segmentId}:${segment.status}:${segment.transcribedMs}`,
    );
    await this.writeDelay();
  };

  mergeSegments = async (
    noteId: string,
    merge: (current: NoteSegment[]) => NoteSegment[],
  ) => {
    if (!this.notes.has(noteId)) return;
    const next = structuredClone(merge(this.getSegments(noteId)));
    next.sort((left, right) => left.index - right.index);
    this.segments.set(noteId, next);
    for (const segment of next) {
      this.log.push(
        `segment:${segment.id}:${segment.status}:${segment.transcribedMs}`,
      );
    }
    await this.writeDelay();
  };

  deleteNote = async (noteId: string, _options?: { deleteAudio: boolean }) => {
    this.removed.add(noteId);
    this.notes.delete(noteId);
    this.segments.delete(noteId);
    this.log.push(`delete-note:${noteId}`);
    await this.writeDelay();
  };

  removeSegment = async (noteId: string, segmentId: string) => {
    this.segments.set(
      noteId,
      this.getSegments(noteId).filter((s) => s.id !== segmentId),
    );
    this.log.push(`remove-segment:${segmentId}`);
    await this.writeDelay();
  };
}
