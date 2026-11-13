import 'dart:async';

import 'package:app/actions/notes_actions.dart';
import 'package:app/actions/revenue_cat_actions.dart';
import 'package:app/api/notes_api.dart';
import 'package:app/model/note_model.dart';
import 'package:app/store/store.dart';
import 'package:app/utils/note_utils.dart';
import 'package:app/utils/theme_utils.dart';
import 'package:app/widgets/notes/note_markdown.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

const _askUnavailableText =
    'Ask becomes available once the meeting is processed.';

class _AskTurn {
  _AskTurn(this.question);

  final String question;
  String answer = '';
  List<NoteAskSource> sources = const [];
  bool isStreaming = true;
  String? error;
}

/// Ephemeral Ask thread about one note ([noteId]) or all notes. Answers
/// stream in as Markdown; cited notes open on tap.
class NoteAskSheet extends StatefulWidget {
  const NoteAskSheet({super.key, this.noteId});

  final String? noteId;

  static Future<void> show(BuildContext context, {String? noteId}) {
    return showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      builder: (_) => FractionallySizedBox(
        heightFactor: 0.92,
        child: NoteAskSheet(noteId: noteId),
      ),
    );
  }

  @override
  State<NoteAskSheet> createState() => _NoteAskSheetState();
}

class _NoteAskSheetState extends State<NoteAskSheet> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final _turns = <_AskTurn>[];
  StreamSubscription<NoteAskEvent>? _subscription;
  bool _isUnavailable = false;

  bool get _isBusy => _turns.isNotEmpty && _turns.last.isStreaming;

  @override
  void dispose() {
    _subscription?.cancel();
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  List<NoteAskMessage> _history() => [
    for (final turn in _turns.where(
      (t) => !t.isStreaming && t.error == null,
    )) ...[
      NoteAskMessage(role: 'user', content: turn.question),
      NoteAskMessage(role: 'assistant', content: turn.answer),
    ],
  ];

  void _ask(String question) {
    final trimmed = question.trim();
    if (trimmed.isEmpty || _isBusy) return;
    final history = _history();
    final turn = _AskTurn(trimmed);
    setState(() {
      _turns.add(turn);
      _input.clear();
    });
    _scrollToEnd();

    _subscription =
        askNotes(
          question: trimmed,
          noteId: widget.noteId,
          history: history,
        ).listen(
          (event) {
            setState(() {
              switch (event) {
                case NoteAskSourcesEvent(:final sources):
                  turn.sources = sources;
                case NoteAskDeltaEvent(:final text):
                  turn.answer += text;
                case NoteAskDoneEvent(:final answer):
                  turn.answer = answer;
                  turn.isStreaming = false;
              }
            });
            _scrollToEnd();
          },
          onError: (Object e) {
            setState(() {
              turn.isStreaming = false;
              if (e is NotesApiException &&
                  e.code == 'transcript_unavailable') {
                _isUnavailable = true;
                _turns.remove(turn);
                return;
              }
              if (e is NotesApiException && e.isQuota) presentPaywall();
              turn.error = e is NotesApiException && e.isNetwork
                  ? "You're offline. Connect and try again."
                  : e is NotesApiException && e.isQuota
                  ? describeNoteError(e.toNoteError())
                  : 'The answer could not be finished.';
            });
          },
          onDone: () => setState(() {
            if (turn.isStreaming) {
              turn.isStreaming = false;
              turn.error = 'The answer could not be finished.';
            }
          }),
        );
  }

  void _scrollToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: Theming.duration,
          curve: Curves.easeOut,
        );
      }
    });
  }

  void _openSource(NoteAskSource source) {
    Navigator.of(context).pop();
    context.push('/dashboard/notes/${source.noteId}');
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final noteId = widget.noteId;
    final canAsk = useAppStore().select(
      context,
      (s) =>
          noteId == null || (buildNoteView(s.notes, noteId)?.canAsk ?? false),
    );
    final isUnavailable = _isUnavailable || !canAsk;
    final muted = theme.colorScheme.onSurface.withValues(alpha: 0.6);

    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: Column(
        children: [
          Padding(
            padding: Theming.padding.onlyHorizontal(),
            child: Row(
              children: [
                Icon(
                  Icons.auto_awesome_outlined,
                  color: theme.colorScheme.primary,
                ),
                const SizedBox(width: 8),
                Text(
                  noteId == null ? 'Ask your notes' : 'Ask about this note',
                  style: theme.textTheme.titleMedium,
                ),
              ],
            ),
          ),
          Expanded(
            child: isUnavailable
                ? Center(
                    child: Padding(
                      padding: Theming.padding,
                      child: Text(
                        _askUnavailableText,
                        textAlign: TextAlign.center,
                        style: theme.textTheme.bodyLarge?.copyWith(
                          color: muted,
                        ),
                      ),
                    ),
                  )
                : _turns.isEmpty
                ? Center(
                    child: Padding(
                      padding: Theming.padding,
                      child: Text(
                        noteId == null
                            ? 'Ask anything about your meetings, like "What did we decide about the launch?"'
                            : 'Ask anything about this meeting, like "What are my action items?"',
                        textAlign: TextAlign.center,
                        style: theme.textTheme.bodyLarge?.copyWith(
                          color: muted,
                        ),
                      ),
                    ),
                  )
                : ListView.builder(
                    controller: _scroll,
                    padding: Theming.padding,
                    itemCount: _turns.length,
                    itemBuilder: (context, index) => _AskTurnView(
                      turn: _turns[index],
                      onOpenSource: _openSource,
                      onRetry: index == _turns.length - 1
                          ? () {
                              final question = _turns.removeLast().question;
                              _ask(question);
                            }
                          : null,
                    ),
                  ),
          ),
          if (!isUnavailable)
            SafeArea(
              top: false,
              child: Padding(
                padding: Theming.padding.withTop(8),
                child: TextField(
                  controller: _input,
                  enabled: !_isBusy,
                  minLines: 1,
                  maxLines: 4,
                  maxLength: 2000,
                  textInputAction: TextInputAction.send,
                  onSubmitted: _ask,
                  decoration: InputDecoration(
                    hintText: _turns.isEmpty
                        ? 'Ask a question'
                        : 'Ask a follow-up',
                    border: const OutlineInputBorder(),
                    counterText: '',
                    suffixIcon: IconButton(
                      icon: const Icon(Icons.arrow_upward),
                      onPressed: _isBusy ? null : () => _ask(_input.text),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _AskTurnView extends StatelessWidget {
  const _AskTurnView({
    required this.turn,
    required this.onOpenSource,
    required this.onRetry,
  });

  final _AskTurn turn;
  final void Function(NoteAskSource source) onOpenSource;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Align(
            alignment: Alignment.centerRight,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                color: theme.colorScheme.primaryContainer,
                borderRadius: BorderRadius.circular(Theming.radiusValue),
              ),
              child: Text(
                turn.question,
                style: TextStyle(color: theme.colorScheme.onPrimaryContainer),
              ),
            ),
          ),
          const SizedBox(height: 12),
          if (turn.answer.isEmpty && turn.isStreaming)
            const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          else
            NoteMarkdown(data: turn.answer),
          if (turn.error != null) ...[
            const SizedBox(height: 8),
            Row(
              children: [
                Icon(
                  Icons.error_outline,
                  size: 16,
                  color: theme.colorScheme.error,
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    turn.error!,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.error,
                    ),
                  ),
                ),
                if (onRetry != null)
                  TextButton(onPressed: onRetry, child: const Text('Retry')),
              ],
            ),
          ],
          if (turn.sources.isNotEmpty && !turn.isStreaming) ...[
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final (index, source) in turn.sources.indexed)
                  ActionChip(
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
