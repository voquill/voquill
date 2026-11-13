import 'dart:async';

import 'package:app/actions/notes_actions.dart';
import 'package:app/actions/revenue_cat_actions.dart';
import 'package:app/actions/snackbar_actions.dart';
import 'package:app/model/note_model.dart';
import 'package:app/store/store.dart';
import 'package:app/utils/note_utils.dart';
import 'package:app/utils/theme_utils.dart';
import 'package:app/widgets/notes/delete_note_dialog.dart';
import 'package:app/widgets/notes/note_ask_sheet.dart';
import 'package:app/widgets/notes/note_elapsed_text.dart';
import 'package:app/widgets/notes/note_markdown.dart';
import 'package:app/widgets/notes/note_state_label.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

const _autosaveDelay = Duration(milliseconds: 800);

enum _NoteMenuAction { resume, regenerate, copyNotes, copyTranscript, delete }

class NotePage extends StatefulWidget {
  const NotePage({super.key, required this.noteId});

  final String noteId;

  @override
  State<NotePage> createState() => _NotePageState();
}

class _NotePageState extends State<NotePage> {
  final _title = TextEditingController();
  final _personalNotes = TextEditingController();
  Timer? _titleTimer;
  Timer? _notesTimer;

  String get _id => widget.noteId;

  @override
  void initState() {
    super.initState();
    final local = getAppState().notes.localNoteById[_id];
    if (local == null || local.existsOnServer) loadNote(_id);
  }

  @override
  void dispose() {
    _flushEdits();
    _title.dispose();
    _personalNotes.dispose();
    super.dispose();
  }

  void _flushEdits() {
    if (_titleTimer?.isActive ?? false) {
      _titleTimer!.cancel();
      updateNoteTitle(_id, _title.text);
    }
    if (_notesTimer?.isActive ?? false) {
      _notesTimer!.cancel();
      updateNotePersonalNotes(_id, _personalNotes.text);
    }
  }

  void _onTitleChanged(String value) {
    _titleTimer?.cancel();
    _titleTimer = Timer(_autosaveDelay, () => updateNoteTitle(_id, value));
  }

  void _onPersonalNotesChanged(String value) {
    _notesTimer?.cancel();
    _notesTimer = Timer(
      _autosaveDelay,
      () => updateNotePersonalNotes(_id, value),
    );
  }

  String? _syncedTitle;
  String? _syncedPersonalNotes;

  /// Fields follow the stored value (the AI title arriving, My notes saved on
  /// another device) until the user changes them here; local typing always
  /// wins over a value that arrives later.
  void _syncFields(NoteView view) {
    _syncedTitle = _follow(_title, view.title, _syncedTitle, _titleTimer);
    _syncedPersonalNotes = _follow(
      _personalNotes,
      view.personalNotes,
      _syncedPersonalNotes,
      _notesTimer,
    );
  }

  String? _follow(
    TextEditingController controller,
    String stored,
    String? lastSynced,
    Timer? pendingSave,
  ) {
    if (controller.text == stored) return stored;
    final isUntouched = lastSynced == null || controller.text == lastSynced;
    final isSaving = pendingSave?.isActive ?? false;
    if (isUntouched && !isSaving && controller.text != stored) {
      controller.text = stored;
    }
    return isUntouched && !isSaving ? stored : lastSynced;
  }

  Future<void> _onMenu(_NoteMenuAction action, NoteView view) async {
    switch (action) {
      case _NoteMenuAction.resume:
        _flushEdits();
        await resumeServerNote(_id);
      case _NoteMenuAction.regenerate:
        await regenerateNote(_id);
      case _NoteMenuAction.copyNotes:
        await Clipboard.setData(
          ClipboardData(text: view.server?.generatedNotes ?? ''),
        );
        showSnackbar('Notes copied', duration: const Duration(seconds: 2));
      case _NoteMenuAction.copyTranscript:
        await Clipboard.setData(
          ClipboardData(
            text: transcriptText(view.server?.segments ?? const []),
          ),
        );
        showSnackbar('Transcript copied', duration: const Duration(seconds: 2));
      case _NoteMenuAction.delete:
        if (!mounted) return;
        if (await confirmDeleteNote(context, title: view.title)) {
          await deleteNote(_id);
          if (mounted) Navigator.of(context).maybePop();
        }
    }
  }

  @override
  Widget build(BuildContext context) {
    final view = useAppStore().select(
      context,
      (s) => buildNoteView(s.notes, _id),
    );
    if (view == null) {
      return Scaffold(
        appBar: AppBar(),
        body: const Center(child: CircularProgressIndicator()),
      );
    }
    _syncFields(view);

    final isReady = view.state == NoteDisplayState.ready;
    final hasTranscript = view.server?.segments?.isNotEmpty ?? false;

    final titleField = Padding(
      padding: Theming.padding.onlyHorizontal(),
      child: TextField(
        controller: _title,
        onChanged: _onTitleChanged,
        onSubmitted: (value) {
          _titleTimer?.cancel();
          updateNoteTitle(_id, value);
        },
        maxLength: 200,
        textCapitalization: TextCapitalization.sentences,
        style: Theme.of(context).textTheme.headlineSmall,
        decoration: const InputDecoration.collapsed(
          hintText: 'Title',
        ).copyWith(counterText: ''),
      ),
    );

    final personalNotesField = _PersonalNotesField(
      controller: _personalNotes,
      onChanged: _onPersonalNotesChanged,
    );

    final menu = PopupMenuButton<_NoteMenuAction>(
      onSelected: (action) => _onMenu(action, view),
      itemBuilder: (_) => [
        if (isReady) ...[
          if (view.server?.source != NoteSource.imported)
            const PopupMenuItem(
              value: _NoteMenuAction.resume,
              child: Text('Resume recording'),
            ),
          const PopupMenuItem(
            value: _NoteMenuAction.regenerate,
            child: Text('Regenerate notes'),
          ),
        ],
        if (view.server?.generatedNotes != null)
          const PopupMenuItem(
            value: _NoteMenuAction.copyNotes,
            child: Text('Copy notes'),
          ),
        if (hasTranscript)
          const PopupMenuItem(
            value: _NoteMenuAction.copyTranscript,
            child: Text('Copy transcript'),
          ),
        const PopupMenuItem(
          value: _NoteMenuAction.delete,
          child: Text('Delete'),
        ),
      ],
    );

    final appBar = AppBar(
      actions: [
        IconButton(
          tooltip: 'Ask',
          icon: const Icon(Icons.auto_awesome_outlined),
          onPressed: () => NoteAskSheet.show(context, noteId: _id),
        ),
        menu,
      ],
    );

    if (view.state.isCapturing) {
      return Scaffold(
        appBar: appBar,
        body: SafeArea(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              titleField,
              const SizedBox(height: 24),
              _RecordingControls(view: view),
              const SizedBox(height: 24),
              Expanded(child: personalNotesField),
            ],
          ),
        ),
      );
    }

    if (isReady && view.server != null) {
      return DefaultTabController(
        length: 3,
        child: Scaffold(
          appBar: appBar,
          body: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              titleField,
              const SizedBox(height: 8),
              if (view.failedSegmentError != null)
                _FailedSegmentBanner(view: view),
              const TabBar(
                tabs: [
                  Tab(text: 'Notes'),
                  Tab(text: 'My notes'),
                  Tab(text: 'Transcript'),
                ],
              ),
              Expanded(
                child: TabBarView(
                  children: [
                    _GeneratedNotes(markdown: view.server!.generatedNotes),
                    Padding(
                      padding: const EdgeInsets.only(top: 16),
                      child: personalNotesField,
                    ),
                    _Transcript(note: view.server!),
                  ],
                ),
              ),
            ],
          ),
        ),
      );
    }

    return Scaffold(
      appBar: appBar,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            titleField,
            const SizedBox(height: 16),
            _StatusCard(view: view),
            const SizedBox(height: 16),
            Expanded(child: personalNotesField),
          ],
        ),
      ),
    );
  }
}

class _PersonalNotesField extends StatelessWidget {
  const _PersonalNotesField({
    required this.controller,
    required this.onChanged,
  });

  final TextEditingController controller;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: Theming.padding.onlyHorizontal().withBottom(
        Theming.paddingValue,
      ),
      child: TextField(
        controller: controller,
        onChanged: onChanged,
        expands: true,
        maxLines: null,
        maxLength: 100000,
        textAlignVertical: TextAlignVertical.top,
        textCapitalization: TextCapitalization.sentences,
        keyboardType: TextInputType.multiline,
        decoration: const InputDecoration(
          labelText: 'My notes',
          hintText: 'Jot down anything you want the notes to focus on',
          alignLabelWithHint: true,
          border: OutlineInputBorder(),
          counterText: '',
        ),
      ),
    );
  }
}

class _RecordingControls extends StatelessWidget {
  const _RecordingControls({required this.view});

  final NoteView view;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isPaused = view.state == NoteDisplayState.paused;
    final isBusy = useAppStore().select(context, (s) => s.notes.isRecorderBusy);
    return Column(
      children: [
        NoteElapsedText(view: view, style: theme.textTheme.displayMedium),
        const SizedBox(height: 4),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            if (!isPaused) ...[const LiveDot(), const SizedBox(width: 6)],
            Text(
              isPaused ? 'Paused' : 'Taking notes',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurface.withValues(alpha: 0.6),
              ),
            ),
          ],
        ),
        const SizedBox(height: 24),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          spacing: 32,
          children: [
            IconButton.outlined(
              iconSize: 32,
              padding: const EdgeInsets.all(16),
              tooltip: isPaused ? 'Resume' : 'Pause',
              icon: Icon(isPaused ? Icons.mic : Icons.pause),
              onPressed: isBusy
                  ? null
                  : () => isPaused
                        ? resumeRecording(view.id)
                        : pauseRecording(view.id),
            ),
            IconButton.filled(
              iconSize: 40,
              padding: const EdgeInsets.all(22),
              tooltip: 'Stop',
              style: IconButton.styleFrom(
                backgroundColor: theme.colorScheme.error,
                foregroundColor: theme.colorScheme.onError,
              ),
              icon: const Icon(Icons.stop_rounded),
              onPressed: isBusy ? null : () => stopRecording(view.id),
            ),
          ],
        ),
      ],
    );
  }
}

class _StatusCard extends StatelessWidget {
  const _StatusCard({required this.view});

  final NoteView view;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final error = view.error;
    final isFailed = view.state == NoteDisplayState.failed;
    final hasLocalAudio = view.local?.segments.isNotEmpty ?? false;

    final (String title, String body) = switch (view.state) {
      NoteDisplayState.waitingForConnection => (
        'Waiting for connection',
        'Your recording is saved on this device and uploads as soon as you are online.',
      ),
      NoteDisplayState.queued => (
        'Queued',
        'Another note is being processed. This one starts as soon as it is done.',
      ),
      NoteDisplayState.uploading => (
        'Uploading',
        'Sending your recording. You can leave this screen.',
      ),
      NoteDisplayState.processing => (
        'Writing your notes',
        'Transcribing and summarizing. This takes about a minute per hour of audio.',
      ),
      NoteDisplayState.failed => (
        'This note could not be processed',
        describeNoteError(error),
      ),
      NoteDisplayState.draft => (
        'Not processed yet',
        'This note was recorded but never sent for notes.',
      ),
      _ => ('', ''),
    };

    return Padding(
      padding: Theming.padding.onlyHorizontal(),
      child: Card(
        elevation: 0,
        color: isFailed
            ? theme.colorScheme.errorContainer
            : theme.colorScheme.surfaceContainerHighest,
        child: Padding(
          padding: Theming.padding,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: theme.textTheme.titleMedium),
              const SizedBox(height: 4),
              Text(body),
              if (isFailed && hasLocalAudio) ...[
                const SizedBox(height: 4),
                const Text('Your recording is safe on this device.'),
              ],
              const SizedBox(height: 12),
              if (view.state.isBusy)
                LinearProgressIndicator(
                  value: view.state == NoteDisplayState.uploading
                      ? view.uploadProgress
                      : null,
                ),
              if (isFailed || view.state == NoteDisplayState.draft)
                Wrap(
                  spacing: 8,
                  children: [
                    if (isQuotaError(error))
                      FilledButton(
                        onPressed: presentPaywall,
                        child: const Text('Upgrade'),
                      ),
                    FilledButton.tonal(
                      onPressed: () => retryNote(view.id),
                      child: Text(isFailed ? 'Retry' : 'Process'),
                    ),
                  ],
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _FailedSegmentBanner extends StatelessWidget {
  const _FailedSegmentBanner({required this.view});

  final NoteView view;

  Future<void> _confirmRemove(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Remove this part?'),
        content: const Text(
          "The part of the recording that couldn't be transcribed is deleted from this device. The rest of the note stays.",
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Remove'),
          ),
        ],
      ),
    );
    if (confirmed ?? false) await dropFailedSegments(view.id);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final error = view.failedSegmentError;
    return MaterialBanner(
      backgroundColor: theme.colorScheme.errorContainer,
      content: Text(
        '${describeNoteError(error)} That part of the recording is safe on this device.',
      ),
      actions: [
        TextButton(
          onPressed: () => _confirmRemove(context),
          child: const Text('Remove'),
        ),
        if (isQuotaError(error))
          TextButton(onPressed: presentPaywall, child: const Text('Upgrade')),
        TextButton(
          onPressed: () => retryNote(view.id),
          child: const Text('Retry'),
        ),
      ],
    );
  }
}

class _GeneratedNotes extends StatelessWidget {
  const _GeneratedNotes({required this.markdown});

  final String? markdown;

  @override
  Widget build(BuildContext context) {
    final markdown = this.markdown;
    if (markdown == null || markdown.trim().isEmpty) {
      return const Center(
        child: Text('No notes were written for this meeting.'),
      );
    }
    return NoteMarkdown(
      data: markdown,
      isScrollable: true,
      padding: Theming.padding.withBottom(48),
    );
  }
}

class _Transcript extends StatelessWidget {
  const _Transcript({required this.note});

  final Note note;

  @override
  Widget build(BuildContext context) {
    final segments = note.segments;
    if (segments == null) {
      return const Center(child: Text('Loading transcript…'));
    }
    final theme = Theme.of(context);
    final muted = theme.textTheme.labelMedium?.copyWith(
      color: theme.colorScheme.onSurface.withValues(alpha: 0.6),
    );
    final lines = transcriptLines(segments);
    if (lines.isEmpty) {
      return const Center(child: Text('No speech was detected.'));
    }

    return ListView.builder(
      padding: Theming.padding.withBottom(48),
      itemCount: lines.length,
      itemBuilder: (context, index) {
        final line = lines[index];
        return Padding(
          padding: const EdgeInsets.only(bottom: 16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (line.label.isNotEmpty) Text(line.label, style: muted),
              const SizedBox(height: 2),
              SelectableText(
                line.text,
                style: line.isFailed
                    ? TextStyle(color: theme.colorScheme.error)
                    : null,
              ),
            ],
          ),
        );
      },
    );
  }
}
