import 'dart:async';

import 'package:app/actions/notes_actions.dart';
import 'package:app/actions/revenue_cat_actions.dart';
import 'package:app/actions/snackbar_actions.dart';
import 'package:app/model/note_model.dart';
import 'package:app/store/store.dart';
import 'package:app/theme/app_colors.dart';
import 'package:app/utils/note_utils.dart';
import 'package:app/utils/theme_utils.dart';
import 'package:app/widgets/notes/ask_dock.dart';
import 'package:app/widgets/notes/ask_thread.dart';
import 'package:app/widgets/notes/delete_note_dialog.dart';
import 'package:app/widgets/notes/note_elapsed_text.dart';
import 'package:app/widgets/notes/note_markdown.dart';
import 'package:app/widgets/notes/note_state_text.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';

const _autosaveDelay = Duration(milliseconds: 800);

/// Readable line length on wide screens and tablets.
const _maxContentWidth = 680.0;

enum NoteSection { notes, myNotes, transcript }

enum _NoteMenuAction { resume, regenerate, copyNotes, copyTranscript, delete }

class NotePage extends StatefulWidget {
  const NotePage({super.key, required this.noteId, this.initialSection});

  final String noteId;

  /// Opens on this section instead of the default (screenshots, deep links).
  final NoteSection? initialSection;

  @override
  State<NotePage> createState() => _NotePageState();
}

class _NotePageState extends State<NotePage> {
  final _title = TextEditingController();
  final _personalNotes = TextEditingController();
  final _titleFocus = FocusNode();
  final _notesFocus = FocusNode();
  Timer? _titleTimer;
  Timer? _notesTimer;
  String? _syncedTitle;
  String? _syncedPersonalNotes;
  NoteSection? _section;
  List<NoteSegment>? _linesSource;
  List<TranscriptLine> _lines = const [];

  /// Owned here so the conversation survives the Ask box stepping aside
  /// while the title or My notes is being typed.
  late final _askThread = AskThread(
    ask: askNotes,
    noteId: widget.noteId,
    onError: noteAskFailed,
  );

  String get _id => widget.noteId;

  @override
  void initState() {
    super.initState();
    _section = widget.initialSection;
    _titleFocus.addListener(_onFocusChanged);
    _notesFocus.addListener(_onFocusChanged);
    noteScreenOpened(_id);
    final local = getAppState().notes.localNoteById[_id];
    if (local == null || local.existsOnServer) loadNote(_id);
  }

  @override
  void dispose() {
    noteScreenClosed(_id);
    _flushEdits();
    _title.dispose();
    _personalNotes.dispose();
    _titleFocus.dispose();
    _notesFocus.dispose();
    _askThread.dispose();
    super.dispose();
  }

  /// The Ask box steps aside while the title or My notes is being typed, so
  /// the keyboard leaves room for the text.
  void _onFocusChanged() => setState(() {});

  bool get _isEditingText => _titleFocus.hasFocus || _notesFocus.hasFocus;

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

  /// Fields follow the stored value (the AI title arriving, My notes saved on
  /// another device) until the user changes them here; local typing always
  /// wins over a value that arrives later, and the cursor is never moved
  /// while the field has focus.
  void _syncFields(NoteView view) {
    _syncedTitle = _follow(
      _title,
      view.title,
      _syncedTitle,
      _titleTimer,
      _titleFocus,
    );
    _syncedPersonalNotes = _follow(
      _personalNotes,
      view.personalNotes,
      _syncedPersonalNotes,
      _notesTimer,
      _notesFocus,
    );
  }

  String? _follow(
    TextEditingController controller,
    String stored,
    String? lastSynced,
    Timer? pendingSave,
    FocusNode focus,
  ) {
    if (controller.text == stored) return stored;
    final isUntouched = lastSynced == null || controller.text == lastSynced;
    final isSaving = pendingSave?.isActive ?? false;
    if (isUntouched && !isSaving && !focus.hasFocus) {
      controller.text = stored;
      return stored;
    }
    return lastSynced;
  }

  List<TranscriptLine> _transcriptLinesFor(List<NoteSegment> segments) {
    if (!identical(segments, _linesSource)) {
      _linesSource = segments;
      _lines = transcriptLines(segments);
    }
    return _lines;
  }

  Future<void> _copy(String text, String confirmation) async {
    await Clipboard.setData(ClipboardData(text: text));
    HapticFeedback.selectionClick();
    showSnackbar(confirmation, duration: const Duration(seconds: 2));
  }

  Future<void> _onMenu(_NoteMenuAction action, NoteView view) async {
    switch (action) {
      case _NoteMenuAction.resume:
        _flushEdits();
        await resumeServerNote(_id);
      case _NoteMenuAction.regenerate:
        await regenerateNote(_id);
      case _NoteMenuAction.copyNotes:
        await _copy(view.server?.generatedNotes ?? '', 'Notes copied');
      case _NoteMenuAction.copyTranscript:
        await _copy(
          transcriptText(view.server?.segments ?? const []),
          'Transcript copied',
        );
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

    final server = view.server;
    final isReady = view.state == NoteDisplayState.ready;
    final hasServerContent =
        server != null &&
        (server.generatedNotes != null || server.status == NoteStatus.ready);
    final sections = hasServerContent
        ? NoteSection.values
        : const [NoteSection.myNotes];
    final section = sections.contains(_section)
        ? _section!
        : view.state.isCapturing || !hasServerContent
        ? NoteSection.myNotes
        : NoteSection.notes;
    final segments = server?.segments;
    final hasTranscript = segments?.any((s) => s.transcript != null) ?? false;

    final menu = PopupMenuButton<_NoteMenuAction>(
      tooltip: 'More',
      onSelected: (action) => _onMenu(action, view),
      itemBuilder: (_) => [
        if (isReady) ...[
          if (server?.source != NoteSource.imported)
            const PopupMenuItem(
              value: _NoteMenuAction.resume,
              child: Text('Resume recording'),
            ),
          const PopupMenuItem(
            value: _NoteMenuAction.regenerate,
            child: Text('Regenerate notes'),
          ),
        ],
        if (server?.generatedNotes != null)
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

    final slivers = <Widget>[
      _content(
        Padding(
          padding: Theming.padding.withTop(4).withBottom(12),
          child: TextField(
            controller: _title,
            focusNode: _titleFocus,
            onChanged: _onTitleChanged,
            onSubmitted: (value) {
              _titleTimer?.cancel();
              updateNoteTitle(_id, value);
            },
            maxLength: 200,
            maxLines: null,
            textInputAction: TextInputAction.done,
            textCapitalization: TextCapitalization.sentences,
            style: Theme.of(context).textTheme.headlineMedium,
            decoration: const InputDecoration.collapsed(
              hintText: 'Title',
              filled: false,
            ).copyWith(counterText: ''),
          ),
        ),
      ),
      _content(_MetaChips(view: view)),
      if (view.state.isCapturing)
        _content(_RecordingCard(view: view, onBeforeStop: _flushEdits)),
      if (view.state.isBusy ||
          view.state == NoteDisplayState.failed ||
          view.state == NoteDisplayState.draft)
        _content(_StatusCard(view: view)),
      if (view.failedSegmentError != null)
        _content(_FailedPartCard(view: view)),
      if (sections.length > 1)
        _content(
          Padding(
            padding: Theming.padding.withTop(20).withBottom(4),
            child: SegmentedButton<NoteSection>(
              showSelectedIcon: false,
              style: SegmentedButton.styleFrom(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                minimumSize: const Size(0, 44),
              ),
              segments: const [
                ButtonSegment(
                  value: NoteSection.notes,
                  label: _SegmentLabel('Notes'),
                ),
                ButtonSegment(
                  value: NoteSection.myNotes,
                  label: _SegmentLabel('My notes'),
                ),
                ButtonSegment(
                  value: NoteSection.transcript,
                  label: _SegmentLabel('Transcript'),
                ),
              ],
              selected: {section},
              onSelectionChanged: (selected) =>
                  setState(() => _section = selected.single),
            ),
          ),
        ),
      ...switch (section) {
        NoteSection.notes => [
          _content(
            _SectionHeader(
              label: 'AI notes',
              action: server?.generatedNotes == null
                  ? null
                  : _CopyButton(
                      label: 'Copy notes',
                      onPressed: () =>
                          _copy(server!.generatedNotes!, 'Notes copied'),
                    ),
            ),
          ),
          _content(_GeneratedNotes(markdown: server?.generatedNotes)),
        ],
        NoteSection.myNotes => [
          _content(const _SectionHeader(label: 'My notes')),
          _content(
            _PersonalNotesField(
              controller: _personalNotes,
              focusNode: _notesFocus,
              onChanged: _onPersonalNotesChanged,
              isRecording: view.state.isCapturing,
            ),
          ),
        ],
        NoteSection.transcript => _transcriptSlivers(segments, hasTranscript),
      },
      const SliverToBoxAdapter(child: SizedBox(height: 24)),
    ];

    return Scaffold(
      appBar: AppBar(actions: [menu]),
      body: Column(
        children: [
          Expanded(
            child: GestureDetector(
              onTap: () => FocusScope.of(context).unfocus(),
              behavior: HitTestBehavior.translucent,
              child: CustomScrollView(
                keyboardDismissBehavior:
                    ScrollViewKeyboardDismissBehavior.onDrag,
                slivers: slivers,
              ),
            ),
          ),
          Visibility(
            visible: !_isEditingText,
            maintainState: true,
            child: AskDock(noteId: _id, thread: _askThread),
          ),
        ],
      ),
    );
  }

  List<Widget> _transcriptSlivers(
    List<NoteSegment>? segments,
    bool hasTranscript,
  ) {
    if (segments == null) {
      return [_content(const _Placeholder(text: 'Loading the transcript…'))];
    }
    final lines = _transcriptLinesFor(segments);
    if (lines.isEmpty) {
      return [
        _content(
          const _Placeholder(text: 'No speech was detected in this recording.'),
        ),
      ];
    }
    return [
      _content(
        _SectionHeader(
          label: 'Transcript',
          action: hasTranscript
              ? _CopyButton(
                  label: 'Copy transcript',
                  onPressed: () =>
                      _copy(transcriptText(segments), 'Transcript copied'),
                )
              : null,
        ),
      ),
      SliverList.builder(
        itemCount: lines.length,
        itemBuilder: (context, index) =>
            _centered(_TranscriptLineView(line: lines[index])),
      ),
    ];
  }
}

Widget _content(Widget child) => SliverToBoxAdapter(child: _centered(child));

Widget _centered(Widget child) => Center(
  child: ConstrainedBox(
    constraints: const BoxConstraints(maxWidth: _maxContentWidth),
    child: SizedBox(width: double.infinity, child: child),
  ),
);

/// Date, length and (when it matters) state, in one compact row.
class _MetaChips extends StatelessWidget {
  const _MetaChips({required this.view});

  final NoteView view;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final isThisYear = view.createdAt.year == DateTime.now().year;
    final date = DateFormat(
      isThisYear ? 'EEE, MMM d · h:mm a' : 'MMM d, y · h:mm a',
    ).format(view.createdAt);
    final stateChip = switch (view.state) {
      NoteDisplayState.ready => null,
      NoteDisplayState.recording => _MetaChip(
        icon: Icons.fiber_manual_record,
        label: 'Taking notes',
        color: colors.error,
      ),
      NoteDisplayState.failed => _MetaChip(
        icon: Icons.error_outline,
        label: "Couldn't process",
        color: colors.error,
      ),
      final state => _MetaChip(
        icon: switch (state) {
          NoteDisplayState.paused => Icons.pause,
          NoteDisplayState.waitingForConnection => Icons.cloud_off_outlined,
          NoteDisplayState.queued => Icons.schedule,
          NoteDisplayState.uploading => Icons.cloud_upload_outlined,
          _ => Icons.auto_awesome_outlined,
        },
        label:
            state == NoteDisplayState.uploading && view.uploadProgress != null
            ? 'Uploading ${(view.uploadProgress! * 100).round()}%'
            : noteStateText(state),
      ),
    };

    return Padding(
      padding: Theming.padding.onlyHorizontal(),
      child: Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          _MetaChip(icon: Icons.calendar_today_outlined, label: date),
          if (!view.state.isCapturing && view.durationMs(DateTime.now()) > 0)
            _MetaChip(
              icon: Icons.timer_outlined,
              label: formatNoteLength(view.durationMs(DateTime.now())),
            ),
          ?stateChip,
        ],
      ),
    );
  }
}

class _MetaChip extends StatelessWidget {
  const _MetaChip({required this.icon, required this.label, this.color});

  final IconData icon;
  final String label;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = context.colors;
    final foreground = color ?? colors.onLevel1.withValues(alpha: 0.7);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: colors.level1,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 16, color: foreground),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              label,
              style: theme.textTheme.labelLarge?.copyWith(color: foreground),
            ),
          ),
        ],
      ),
    );
  }
}

/// One line at any text size: large text shrinks to fit rather than
/// breaking a word across lines.
class _SegmentLabel extends StatelessWidget {
  const _SegmentLabel(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => FittedBox(
    fit: BoxFit.scaleDown,
    child: Text(text, maxLines: 1, softWrap: false),
  );
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({required this.label, this.action});

  final String label;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: Theming.padding.withTop(16).withBottom(4).copyWith(right: 4),
      child: SizedBox(
        height: 44,
        child: Row(
          children: [
            Expanded(
              child: Semantics(
                header: true,
                child: Text(
                  label,
                  style: theme.textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.w600,
                    color: context.colors.onLevel0.withValues(alpha: 0.6),
                  ),
                ),
              ),
            ),
            ?action,
          ],
        ),
      ),
    );
  }
}

class _CopyButton extends StatelessWidget {
  const _CopyButton({required this.label, required this.onPressed});

  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return TextButton.icon(
      onPressed: onPressed,
      style: TextButton.styleFrom(
        minimumSize: const Size(44, 44),
        padding: const EdgeInsets.symmetric(horizontal: 12),
      ),
      icon: const Icon(Icons.copy, size: 18),
      label: Text(label),
    );
  }
}

class _Placeholder extends StatelessWidget {
  const _Placeholder({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: Theming.padding.withTop(32),
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
          color: context.colors.onLevel0.withValues(alpha: 0.6),
        ),
      ),
    );
  }
}

class _PersonalNotesField extends StatelessWidget {
  const _PersonalNotesField({
    required this.controller,
    required this.focusNode,
    required this.onChanged,
    required this.isRecording,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final ValueChanged<String> onChanged;
  final bool isRecording;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: Theming.padding.withTop(0),
      child: TextField(
        controller: controller,
        focusNode: focusNode,
        onChanged: onChanged,
        minLines: 8,
        maxLines: null,
        maxLength: 100000,
        textCapitalization: TextCapitalization.sentences,
        keyboardType: TextInputType.multiline,
        style: Theme.of(context).textTheme.bodyMedium,
        decoration: InputDecoration(
          hintText: isRecording
              ? 'Jot down anything the notes should focus on'
              : 'Your own notes. The AI notes never change them.',
          alignLabelWithHint: true,
          counterText: '',
        ),
      ),
    );
  }
}

/// The big timer and Pause/Stop while a meeting records. It sits in the
/// document, under the title, so the Ask box keeps the bottom of the screen.
class _RecordingCard extends StatelessWidget {
  const _RecordingCard({required this.view, required this.onBeforeStop});

  final NoteView view;

  /// Saves typing still waiting for autosave, so Stop sends the latest
  /// My notes and title.
  final VoidCallback onBeforeStop;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = context.colors;
    final isPaused = view.state == NoteDisplayState.paused;
    final isBusy = useAppStore().select(context, (s) => s.notes.isRecorderBusy);

    return Padding(
      padding: Theming.padding.withTop(16).withBottom(0),
      child: Material(
        color: colors.level1,
        borderRadius: const BorderRadius.all(Theming.radius),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 16, 16),
          child: Row(
            children: [
              Expanded(
                child: Semantics(
                  label: isPaused ? 'Paused' : 'Recording',
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      FittedBox(
                        fit: BoxFit.scaleDown,
                        alignment: Alignment.centerLeft,
                        child: NoteElapsedText(
                          view: view,
                          style: theme.textTheme.headlineLarge?.copyWith(
                            fontWeight: FontWeight.w500,
                            color: isPaused
                                ? colors.onLevel1.withValues(alpha: 0.6)
                                : null,
                          ),
                        ),
                      ),
                      if (isPaused)
                        Text(
                          'Resume to keep recording, or stop to write the notes.',
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: colors.onLevel1.withValues(alpha: 0.6),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
              IconButton.outlined(
                iconSize: 28,
                padding: const EdgeInsets.all(12),
                tooltip: isPaused ? 'Resume recording' : 'Pause recording',
                style: IconButton.styleFrom(
                  side: BorderSide(
                    color: colors.onLevel1.withValues(alpha: 0.3),
                  ),
                ),
                icon: Icon(isPaused ? Icons.mic : Icons.pause),
                onPressed: isBusy
                    ? null
                    : () => isPaused
                          ? resumeRecording(view.id)
                          : pauseRecording(view.id),
              ),
              const SizedBox(width: 12),
              IconButton.filled(
                iconSize: 32,
                padding: const EdgeInsets.all(14),
                tooltip: 'Stop and write notes',
                style: IconButton.styleFrom(
                  backgroundColor: colors.error,
                  foregroundColor: colors.onError,
                ),
                icon: const Icon(Icons.stop_rounded),
                onPressed: isBusy
                    ? null
                    : () {
                        HapticFeedback.mediumImpact();
                        onBeforeStop();
                        stopRecording(view.id);
                      },
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _StatusCard extends StatelessWidget {
  const _StatusCard({required this.view});

  final NoteView view;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = context.colors;
    final error = view.error;
    final isFailed = view.state == NoteDisplayState.failed;
    final hasLocalAudio = view.local?.segments.isNotEmpty ?? false;
    final progress = view.uploadProgress;

    final body = switch (view.state) {
      NoteDisplayState.waitingForConnection =>
        'Your recording is saved on this phone. It uploads when you are back online.',
      NoteDisplayState.queued =>
        'Your plan processes a limited number of notes at once. This one starts by itself shortly.',
      NoteDisplayState.uploading =>
        view.local?.source == NoteSource.imported
            ? 'Sending your transcript. You can leave this screen.'
            : 'You can leave this screen. The upload continues.',
      NoteDisplayState.processing =>
        'Transcribing and writing your notes. About a minute per hour of audio.',
      NoteDisplayState.failed => describeNoteError(error),
      NoteDisplayState.draft => 'This recording was never sent for notes.',
      _ => '',
    };

    return Padding(
      padding: Theming.padding.withTop(16).withBottom(0),
      child: Material(
        color: isFailed ? colors.error.withValues(alpha: 0.1) : colors.level1,
        borderRadius: const BorderRadius.all(Theming.radius),
        child: Padding(
          padding: Theming.padding,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(body, style: theme.textTheme.bodyMedium),
              if (isFailed && hasLocalAudio)
                Text(
                  'Your recording is safe on this phone.',
                  style: theme.textTheme.bodyMedium,
                ),
              if (view.state == NoteDisplayState.uploading ||
                  view.state == NoteDisplayState.processing) ...[
                const SizedBox(height: 12),
                LinearProgressIndicator(
                  value: view.state == NoteDisplayState.uploading
                      ? progress
                      : null,
                  borderRadius: BorderRadius.circular(4),
                ),
              ],
              if (isFailed || view.state == NoteDisplayState.draft) ...[
                const SizedBox(height: 12),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    FilledButton(
                      onPressed: () => retryNote(view.id),
                      child: Text(isFailed ? 'Try again' : 'Write notes'),
                    ),
                    if (canUpgradeFor(error))
                      OutlinedButton(
                        onPressed: presentPaywall,
                        child: const Text('Upgrade'),
                      ),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _FailedPartCard extends StatelessWidget {
  const _FailedPartCard({required this.view});

  final NoteView view;

  Future<void> _confirmRemove(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Remove this part?'),
        content: const Text(
          "The part of the recording that couldn't be transcribed is deleted from this phone. The rest of the note stays.",
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
    final colors = context.colors;
    final error = view.failedSegmentError;
    return Padding(
      padding: Theming.padding.withTop(16).withBottom(0),
      child: Material(
        color: colors.error.withValues(alpha: 0.1),
        borderRadius: const BorderRadius.all(Theming.radius),
        child: Padding(
          padding: Theming.padding,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                "Part of this meeting couldn't be transcribed",
                style: theme.textTheme.titleSmall?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                '${describeNoteError(error)} That part is safe on this phone.',
                style: theme.textTheme.bodyMedium,
              ),
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  FilledButton(
                    onPressed: () => retryNote(view.id),
                    child: const Text('Try again'),
                  ),
                  if (canUpgradeFor(error))
                    OutlinedButton(
                      onPressed: presentPaywall,
                      child: const Text('Upgrade'),
                    ),
                  TextButton(
                    onPressed: () => _confirmRemove(context),
                    child: const Text('Remove part'),
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

class _GeneratedNotes extends StatelessWidget {
  const _GeneratedNotes({required this.markdown});

  final String? markdown;

  @override
  Widget build(BuildContext context) {
    final markdown = this.markdown;
    if (markdown == null || markdown.trim().isEmpty) {
      return const _Placeholder(
        text: 'No notes were written for this meeting.',
      );
    }
    return NoteMarkdown(data: markdown, padding: Theming.padding.withTop(4));
  }
}

class _TranscriptLineView extends StatelessWidget {
  const _TranscriptLineView({required this.line});

  final TranscriptLine line;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = context.colors;
    return Padding(
      padding: Theming.padding.withTop(0).withBottom(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (line.label.isNotEmpty)
            Text(
              line.label,
              style: theme.textTheme.labelLarge?.copyWith(
                color: colors.onLevel0.withValues(alpha: 0.6),
              ),
            ),
          const SizedBox(height: 2),
          SelectableText(
            line.text,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: line.isFailed ? colors.error : null,
            ),
          ),
        ],
      ),
    );
  }
}
