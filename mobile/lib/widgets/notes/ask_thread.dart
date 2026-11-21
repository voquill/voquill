import 'dart:async';

import 'package:app/api/notes_api.dart';
import 'package:app/model/note_model.dart';
import 'package:app/utils/note_utils.dart';
import 'package:flutter/foundation.dart';

typedef AskFunction =
    Stream<NoteAskEvent> Function({
      required String question,
      String? noteId,
      List<NoteAskMessage> history,
    });

const askIncompleteText = 'The answer could not be finished.';

class AskTurn {
  AskTurn(this.question);

  final String question;
  String answer = '';
  List<NoteAskSource> sources = const [];
  bool isStreaming = true;

  /// Plain-language reason the answer failed or stopped early.
  String? error;
}

/// One ephemeral Ask conversation, about a note ([noteId]) or all notes.
/// Streamed text is replaced by `done.answer` when it arrives; follow-ups
/// send the finished turns as history.
class AskThread extends ChangeNotifier {
  AskThread({required this.ask, this.noteId, this.onError});

  final AskFunction ask;
  final String? noteId;

  /// Lets the app react to errors beyond this thread (daily limit, offline).
  final void Function(NotesApiException error)? onError;

  final List<AskTurn> turns = [];
  bool isExpanded = false;
  StreamSubscription<NoteAskEvent>? _subscription;

  bool get isBusy => turns.isNotEmpty && turns.last.isStreaming;
  bool get hasTurns => turns.isNotEmpty;

  /// The contract accepts the last 20 messages, each up to 8,000 chars.
  static const maxHistoryMessages = 20;
  static const maxHistoryMessageChars = 8000;

  List<NoteAskMessage> _history() {
    final messages = [
      for (final turn in turns.where(
        (t) => !t.isStreaming && t.error == null,
      )) ...[
        NoteAskMessage(role: 'user', content: turn.question),
        NoteAskMessage(role: 'assistant', content: turn.answer),
      ],
    ];
    final recent = messages.length > maxHistoryMessages
        ? messages.sublist(messages.length - maxHistoryMessages)
        : messages;
    return [
      for (final message in recent)
        message.content.length <= maxHistoryMessageChars
            ? message
            : NoteAskMessage(
                role: message.role,
                content: message.content.substring(0, maxHistoryMessageChars),
              ),
    ];
  }

  /// Returns false when [question] is blank or an answer is still streaming.
  bool send(String question) {
    final trimmed = question.trim();
    if (trimmed.isEmpty || isBusy) return false;
    final history = _history();
    final turn = AskTurn(trimmed);
    turns.add(turn);
    isExpanded = true;
    notifyListeners();

    _subscription = ask(question: trimmed, noteId: noteId, history: history)
        .listen(
          (event) {
            switch (event) {
              case NoteAskSourcesEvent(:final sources):
                turn.sources = sources;
              case NoteAskDeltaEvent(:final text):
                turn.answer += text;
              case NoteAskDoneEvent(:final answer):
                turn.answer = answer;
                turn.isStreaming = false;
            }
            notifyListeners();
          },
          onError: (Object e) {
            turn.isStreaming = false;
            if (e is NotesApiException) {
              onError?.call(e);
              turn.error = e.code == 'ask_failed'
                  ? askIncompleteText
                  : describeApiError(e);
            } else {
              turn.error = askIncompleteText;
            }
            notifyListeners();
          },
          onDone: () {
            if (turn.isStreaming) {
              turn.isStreaming = false;
              turn.error = askIncompleteText;
              notifyListeners();
            }
          },
        );
    return true;
  }

  /// Asks the last question again, replacing its failed answer.
  void retryLast() {
    if (isBusy || turns.isEmpty || turns.last.error == null) return;
    final question = turns.removeLast().question;
    send(question);
  }

  void setExpanded(bool value) {
    if (isExpanded == value) return;
    isExpanded = value;
    notifyListeners();
  }

  void clear() {
    _subscription?.cancel();
    _subscription = null;
    turns.clear();
    isExpanded = false;
    notifyListeners();
  }

  @override
  void dispose() {
    _subscription?.cancel();
    super.dispose();
  }
}
