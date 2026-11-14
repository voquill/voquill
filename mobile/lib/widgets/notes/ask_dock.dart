import 'dart:async';

import 'package:app/actions/notes_actions.dart';
import 'package:app/model/note_model.dart';
import 'package:app/store/store.dart';
import 'package:app/theme/app_colors.dart';
import 'package:app/utils/note_utils.dart';
import 'package:app/utils/theme_utils.dart';
import 'package:app/widgets/notes/ask_thread.dart';
import 'package:app/widgets/notes/note_markdown.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

/// The Ask box docked at the bottom of the notes list ([noteId] null: all
/// notes) and of a note. Answers open in a panel that grows up from the box
/// over the content, at most about half the screen, and can be collapsed or
/// cleared. When Ask cannot run the box stays, disabled, with one line why.
class AskDock extends StatefulWidget {
  const AskDock({super.key, this.noteId, this.trailing, this.thread});

  final String? noteId;

  /// Shown right of the field (the list's New button).
  final Widget? trailing;

  /// Owned by the caller when given (the note page keeps its conversation
  /// while the box steps aside for typing); created here otherwise.
  final AskThread? thread;

  @override
  State<AskDock> createState() => _AskDockState();
}

class _AskDockState extends State<AskDock> {
  late final AskThread _thread =
      widget.thread ??
      AskThread(ask: askNotes, noteId: widget.noteId, onError: noteAskFailed);
  final _input = TextEditingController();
  final _focus = FocusNode();

  /// Re-enables the box when Ask's daily limit resets.
  Timer? _limitTimer;
  String? _limitTimerFor;

  @override
  void initState() {
    super.initState();
    _thread.addListener(_onThreadChanged);
  }

  @override
  void dispose() {
    _thread.removeListener(_onThreadChanged);
    if (widget.thread == null) _thread.dispose();
    _input.dispose();
    _focus.dispose();
    _limitTimer?.cancel();
    super.dispose();
  }

  void _onThreadChanged() => setState(() {});

  void _send() {
    if (_thread.send(_input.text)) _input.clear();
  }

  void _openSource(NoteAskSource source) {
    _thread.setExpanded(false);
    context.push('/dashboard/notes/${source.noteId}');
  }

  void _scheduleLimitReset(String? availableAt) {
    if (availableAt == _limitTimerFor) return;
    _limitTimerFor = availableAt;
    _limitTimer?.cancel();
    final at = DateTime.tryParse(availableAt ?? '');
    final wait = at?.difference(DateTime.now());
    if (wait != null && !wait.isNegative) {
      _limitTimer = Timer(wait + const Duration(seconds: 1), () {
        if (mounted) setState(() {});
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = context.colors;
    _scheduleLimitReset(
      useAppStore().select(context, (s) => s.notes.askAvailableAt),
    );
    final reason = useAppStore().select(
      context,
      (s) => askUnavailableReason(
        s.notes,
        noteId: widget.noteId,
        now: DateTime.now(),
      ),
    );
    final isEnabled = reason == null && !_thread.isBusy;
    final hint = widget.noteId == null
        ? 'Ask your notes'
        : 'Ask about this meeting';

    return Material(
      color: colors.level0,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: Theming.padding.withTop(8).withBottom(8),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (_thread.hasTurns)
                _ThreadPanel(thread: _thread, onOpenSource: _openSource),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _input,
                      focusNode: _focus,
                      enabled: reason == null,
                      readOnly: _thread.isBusy,
                      minLines: 1,
                      maxLines: 4,
                      maxLength: 2000,
                      textInputAction: TextInputAction.send,
                      textCapitalization: TextCapitalization.sentences,
                      onSubmitted: (_) => _send(),
                      onTap: () => _thread.setExpanded(true),
                      decoration: InputDecoration(
                        hintText: hint,
                        hintMaxLines: 1,
                        counterText: '',
                        isDense: true,
                        contentPadding: const EdgeInsets.fromLTRB(
                          20,
                          14,
                          8,
                          14,
                        ),
                        prefixIcon: const Icon(Icons.auto_awesome_outlined),
                        disabledBorder: const OutlineInputBorder(
                          borderSide: BorderSide.none,
                          borderRadius: BorderRadius.all(Theming.radius),
                        ),
                        suffixIcon: IconButton(
                          tooltip: 'Send',
                          icon: const Icon(Icons.arrow_upward),
                          onPressed: isEnabled ? _send : null,
                        ),
                      ),
                    ),
                  ),
                  if (widget.trailing != null) ...[
                    const SizedBox(width: 12),
                    widget.trailing!,
                  ],
                ],
              ),
              if (reason != null)
                Padding(
                  padding: const EdgeInsets.only(top: 6, left: 4),
                  child: Text(
                    reason,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: colors.onLevel0.withValues(alpha: 0.6),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ThreadPanel extends StatelessWidget {
  const _ThreadPanel({required this.thread, required this.onOpenSource});

  final AskThread thread;
  final void Function(NoteAskSource source) onOpenSource;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = context.colors;
    final count = thread.turns.length;
    final header = Row(
      children: [
        const SizedBox(width: 16),
        Icon(Icons.auto_awesome_outlined, size: 18, color: colors.onLevel1),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            thread.isExpanded
                ? 'Ask'
                : count == 1
                ? '1 answer'
                : '$count answers',
            style: theme.textTheme.titleSmall,
          ),
        ),
        IconButton(
          tooltip: thread.isExpanded ? 'Hide answers' : 'Show answers',
          icon: Icon(thread.isExpanded ? Icons.expand_more : Icons.expand_less),
          onPressed: () => thread.setExpanded(!thread.isExpanded),
        ),
        IconButton(
          tooltip: 'Clear conversation',
          icon: const Icon(Icons.close),
          onPressed: thread.clear,
        ),
      ],
    );

    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Material(
        color: colors.level1,
        borderRadius: const BorderRadius.all(Theming.radius),
        clipBehavior: Clip.antiAlias,
        child: AnimatedSize(
          duration: Theming.duration,
          alignment: Alignment.bottomCenter,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              InkWell(
                onTap: () => thread.setExpanded(!thread.isExpanded),
                child: header,
              ),
              if (thread.isExpanded)
                ConstrainedBox(
                  constraints: BoxConstraints(
                    maxHeight: MediaQuery.sizeOf(context).height * 0.45,
                  ),
                  child: ListView.builder(
                    reverse: true,
                    shrinkWrap: true,
                    padding: Theming.padding.withTop(0),
                    itemCount: count,
                    itemBuilder: (context, index) {
                      final turnIndex = count - 1 - index;
                      return AskTurnView(
                        turn: thread.turns[turnIndex],
                        onOpenSource: onOpenSource,
                        onRetry: turnIndex == count - 1
                            ? thread.retryLast
                            : null,
                      );
                    },
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class AskTurnView extends StatelessWidget {
  const AskTurnView({
    super.key,
    required this.turn,
    required this.onOpenSource,
    required this.onRetry,
  });

  final AskTurn turn;
  final void Function(NoteAskSource source) onOpenSource;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = context.colors;
    final muted = colors.onLevel1.withValues(alpha: 0.6);
    return Padding(
      padding: const EdgeInsets.only(top: 8, bottom: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Align(
            alignment: Alignment.centerRight,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                color: colors.primary,
                borderRadius: BorderRadius.circular(Theming.radiusValue),
              ),
              child: Text(
                turn.question,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: colors.onPrimary,
                ),
              ),
            ),
          ),
          const SizedBox(height: 12),
          if (turn.answer.isEmpty && turn.isStreaming)
            Row(
              children: [
                const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
                const SizedBox(width: 10),
                Text(
                  'Thinking…',
                  style: theme.textTheme.bodyMedium?.copyWith(color: muted),
                ),
              ],
            )
          else if (turn.answer.isNotEmpty)
            NoteMarkdown(data: turn.answer),
          if (turn.error != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Row(
                children: [
                  Icon(Icons.error_outline, size: 18, color: colors.error),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      turn.error!,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: colors.error,
                      ),
                    ),
                  ),
                  if (onRetry != null)
                    TextButton(onPressed: onRetry, child: const Text('Retry')),
                ],
              ),
            ),
          if (turn.sources.isNotEmpty && !turn.isStreaming) ...[
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final (index, source) in turn.sources.indexed)
                  ActionChip(
                    backgroundColor: colors.level0,
                    side: BorderSide.none,
                    avatar: Text('${index + 1}'),
                    label: Text(source.title, overflow: TextOverflow.ellipsis),
                    onPressed: () => onOpenSource(source),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
