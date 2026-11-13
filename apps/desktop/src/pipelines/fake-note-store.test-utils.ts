import type { Note, NoteSegment } from "@voquill/types";
import type { NoteStore } from "./local-note.pipeline";

/** In-memory note store; `log` records writes and deletions in the order they became durable. */
export class FakeNoteStore implements NoteStore {
  notes = new Map<string, Note>();
  segments = new Map<string, NoteSegment[]>();
  log: string[] = [];

  getNote = (noteId: string) => this.notes.get(noteId) ?? null;
  getNotes = () => [...this.notes.values()];
  getSegments = (noteId: string) => this.segments.get(noteId) ?? [];
  loadSegments = async (noteId: string) => this.getSegments(noteId);

  insertNote = async (note: Note, segments: NoteSegment[]) => {
    this.notes.set(note.id, structuredClone(note));
    this.segments.set(note.id, structuredClone(segments));
    this.log.push(`insert:${note.id}`);
  };

  updateNote = async (noteId: string, recipe: (note: Note) => void) => {
    const note = this.notes.get(noteId);
    if (!note) return;
    const before = note.status;
    recipe(note);
    if (note.status !== before) {
      this.log.push(`note:${note.status}`);
    }
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
  };

  deleteNote = async (noteId: string) => {
    this.notes.delete(noteId);
    this.segments.delete(noteId);
    this.log.push(`delete-note:${noteId}`);
  };

  putNote = async (note: Note) => {
    const before = this.notes.get(note.id)?.status;
    this.notes.set(note.id, structuredClone(note));
    if (note.status !== before) {
      this.log.push(`note:${note.status}`);
    }
  };

  putSegment = async (segment: NoteSegment) => {
    const segments = this.segments.get(segment.noteId) ?? [];
    const next = segments.filter((s) => s.id !== segment.id);
    next.push(structuredClone(segment));
    next.sort((left, right) => left.index - right.index);
    this.segments.set(segment.noteId, next);
    this.log.push(
      `segment:${segment.id}:${segment.status}:${segment.transcribedMs}`,
    );
  };

  removeSegment = async (noteId: string, segmentId: string) => {
    this.segments.set(
      noteId,
      this.getSegments(noteId).filter((s) => s.id !== segmentId),
    );
    this.log.push(`remove-segment:${segmentId}`);
  };
}
