import 'dart:async';

import 'package:app/api/notes_api.dart';
import 'package:app/model/note_model.dart';
import 'package:app/widgets/notes/ask_thread.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late StreamController<NoteAskEvent> stream;
  late List<({String question, String? noteId, List<NoteAskMessage> history})>
  calls;
  late List<NotesApiException> errors;

  AskThread thread() => AskThread(
    noteId: 'n1',
    onError: errors.add,
    ask: ({required question, noteId, history = const []}) {
      calls.add((question: question, noteId: noteId, history: history));
      stream = StreamController<NoteAskEvent>();
      return stream.stream;
    },
  );

  setUp(() {
    calls = [];
    errors = [];
  });

  test('streams deltas, then replaces them with the final answer', () async {
    final ask = thread();
    expect(ask.send('  What did we decide? '), isTrue);
    expect(ask.isBusy, isTrue);
    expect(ask.isExpanded, isTrue);
    expect(calls.single.question, 'What did we decide?');
    expect(calls.single.noteId, 'n1');

    stream.add(
      const NoteAskSourcesEvent([NoteAskSource(noteId: 'n1', title: 'Sync')]),
    );
    stream.add(const NoteAskDeltaEvent('Ship '));
    stream.add(const NoteAskDeltaEvent('Friday'));
    await pumpEventQueue();
    expect(ask.turns.single.answer, 'Ship Friday');

    stream.add(const NoteAskDoneEvent('Ship on **Friday** [1].'));
    await pumpEventQueue();
    expect(ask.turns.single.answer, 'Ship on **Friday** [1].');
    expect(ask.turns.single.sources.single.title, 'Sync');
    expect(ask.isBusy, isFalse);
  });

  test(
    'follow-ups send finished turns as history and ignore blank input',
    () async {
      final ask = thread();
      ask.send('First?');
      stream.add(const NoteAskDoneEvent('One.'));
      await pumpEventQueue();
      expect(ask.send('   '), isFalse);
      ask.send('Second?');
      expect(calls.last.history.map((m) => '${m.role}:${m.content}'), [
        'user:First?',
        'assistant:One.',
      ]);
      expect(ask.send('Third?'), isFalse, reason: 'one answer at a time');
    },
  );

  test('history keeps the last 20 messages of 8,000 characters', () async {
    final ask = thread();
    for (var i = 0; i < 12; i++) {
      ask.send('Q$i?');
      stream.add(NoteAskDoneEvent(i == 11 ? 'x' * 9000 : 'A$i.'));
      await pumpEventQueue();
    }
    ask.send('Last?');
    final history = calls.last.history;
    expect(history, hasLength(AskThread.maxHistoryMessages));
    expect(history.first.content, 'Q2?');
    expect(history.last.content, hasLength(AskThread.maxHistoryMessageChars));
  });

  test(
    'errors become plain text; the daily limit is reported upward',
    () async {
      final ask = thread();
      ask.send('Q?');
      stream.addError(
        const NotesApiException(
          statusCode: 429,
          code: 'ask_limit_exceeded',
          message: 'x',
          details: {'retryAfterSeconds': 120},
        ),
      );
      await pumpEventQueue();
      expect(
        ask.turns.single.error,
        startsWith("You've reached today's limit for Ask."),
      );
      expect(errors.single.code, 'ask_limit_exceeded');
      expect(ask.isBusy, isFalse);
    },
  );

  test(
    'a stream that ends early is marked incomplete and can be retried',
    () async {
      final ask = thread();
      ask.send('Q?');
      stream.add(const NoteAskDeltaEvent('Partial'));
      await stream.close();
      await pumpEventQueue();
      expect(ask.turns.single.answer, 'Partial');
      expect(ask.turns.single.error, askIncompleteText);

      ask.retryLast();
      expect(calls, hasLength(2));
      expect(ask.turns, hasLength(1));
      expect(ask.turns.single.error, isNull);
    },
  );

  test(
    'collapse keeps the thread; clear removes it and stops streaming',
    () async {
      final ask = thread();
      ask.send('Q?');
      ask.setExpanded(false);
      expect(ask.hasTurns, isTrue);
      expect(ask.isExpanded, isFalse);
      ask.clear();
      expect(ask.hasTurns, isFalse);
      expect(stream.hasListener, isFalse);
    },
  );
}
