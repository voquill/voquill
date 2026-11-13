import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:app/model/local_note_model.dart';
import 'package:app/model/note_model.dart';
import 'package:path/path.dart' as p;

const _snapshotFileName = 'local_notes.json';
const _cacheFileName = 'notes_cache.json';
const _importFileName = 'import.txt';

/// Durable on-device storage for one user's notes: the [LocalNotesSnapshot],
/// segment audio and import transcripts under `<root>/<noteId>/`, and a cache
/// of the first page of server notes for offline cold starts.
class LocalNoteStore {
  LocalNoteStore(this.root);

  final Directory root;
  Future<void> _writes = Future.value();

  Directory noteDirectory(String noteId) =>
      Directory(p.join(root.path, 'notes', noteId));

  File segmentFile(String noteId, String fileName) =>
      File(p.join(noteDirectory(noteId).path, fileName));

  File importFile(String noteId) => segmentFile(noteId, _importFileName);

  Future<LocalNotesSnapshot> loadSnapshot() async {
    final json = await _readJson(_snapshotFileName);
    return json == null
        ? const LocalNotesSnapshot()
        : LocalNotesSnapshot.fromJson(json);
  }

  Future<void> saveSnapshot(LocalNotesSnapshot snapshot) {
    return _write(_snapshotFileName, snapshot.toJson());
  }

  Future<List<Note>> loadCachedNotes() async {
    final json = await _readJson(_cacheFileName);
    if (json == null) return const [];
    return (json['notes'] as List)
        .map((e) => Note.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<void> saveCachedNotes(List<Note> notes) {
    return _write(_cacheFileName, {
      'notes': notes.map((n) => n.withoutSegments().toJson()).toList(),
    });
  }

  Future<void> writeImportTranscript(String noteId, String transcript) async {
    final file = importFile(noteId);
    await file.parent.create(recursive: true);
    await file.writeAsString(transcript, flush: true);
  }

  /// Everything stored for a note; only for a note the user deleted.
  Future<void> deleteNoteFiles(String noteId) async {
    final dir = noteDirectory(noteId);
    if (await dir.exists()) await dir.delete(recursive: true);
  }

  Future<void> deleteSegmentFile(String noteId, String fileName) async {
    final file = segmentFile(noteId, fileName);
    if (await file.exists()) await file.delete();
    await _deleteDirectoryIfEmpty(noteDirectory(noteId));
  }

  Future<void> deleteImportTranscript(String noteId) =>
      deleteSegmentFile(noteId, _importFileName);

  Future<void> _deleteDirectoryIfEmpty(Directory dir) async {
    if (await dir.exists() && await dir.list().isEmpty) await dir.delete();
  }

  /// Files on disk per note id, to find audio no snapshot entry references.
  Future<Map<String, List<File>>> listNoteFiles() async {
    final notesDir = Directory(p.join(root.path, 'notes'));
    if (!await notesDir.exists()) return const {};
    final result = <String, List<File>>{};
    await for (final dir in notesDir.list()) {
      if (dir is! Directory) continue;
      final files = await dir
          .list()
          .where((e) => e is File)
          .cast<File>()
          .toList();
      result[p.basename(dir.path)] = files;
    }
    return result;
  }

  static bool isImportFile(File file) =>
      p.basename(file.path) == _importFileName;

  /// Moves an unreadable snapshot aside so the app can start and the audio
  /// it referenced can be recovered from disk.
  Future<void> quarantineSnapshot() async {
    final file = File(p.join(root.path, _snapshotFileName));
    if (await file.exists()) {
      await file.rename(
        '${file.path}.unreadable-${DateTime.now().millisecondsSinceEpoch}',
      );
    }
  }

  /// Completes once every queued write reached the disk.
  Future<void> flush() => _writes;

  Future<Map<String, dynamic>?> _readJson(String name) async {
    final file = File(p.join(root.path, name));
    if (!await file.exists()) return null;
    final text = await file.readAsString();
    if (text.isEmpty) return null;
    return jsonDecode(text) as Map<String, dynamic>;
  }

  /// Serialized, atomic (temp file + rename) so a crash mid-write never
  /// leaves a truncated snapshot behind.
  Future<void> _write(String name, Map<String, dynamic> json) {
    final encoded = jsonEncode(json);
    final next = _writes.then((_) async {
      await root.create(recursive: true);
      final target = File(p.join(root.path, name));
      final temp = File('${target.path}.tmp');
      await temp.writeAsString(encoded, flush: true);
      await temp.rename(target.path);
    });
    _writes = next.catchError((_) {});
    return next;
  }
}
