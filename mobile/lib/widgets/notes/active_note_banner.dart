import 'package:app/store/store.dart';
import 'package:app/utils/note_utils.dart';
import 'package:app/utils/theme_utils.dart';
import 'package:app/widgets/common/app_animated_size.dart';
import 'package:app/widgets/notes/note_elapsed_text.dart';
import 'package:app/widgets/notes/note_state_label.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

/// Strip above the tab bar while a meeting records or is paused; tapping it
/// returns to the note.
class ActiveNoteBanner extends StatelessWidget {
  const ActiveNoteBanner({super.key});

  @override
  Widget build(BuildContext context) {
    final view = useAppStore().select(context, (s) {
      final note = s.notes.capturingNote;
      return note == null ? null : buildNoteView(s.notes, note.id);
    });
    final theme = Theme.of(context);

    return AppAnimatedSize(
      child: view == null
          ? const SizedBox(width: double.infinity)
          : Material(
              color: theme.colorScheme.errorContainer,
              child: InkWell(
                onTap: () => context.push('/dashboard/notes/${view.id}'),
                child: Padding(
                  padding: Theming.padding.withVertical(10),
                  child: Row(
                    children: [
                      if (view.state == NoteDisplayState.recording)
                        const LiveDot()
                      else
                        Icon(
                          Icons.pause,
                          size: 16,
                          color: theme.colorScheme.onErrorContainer,
                        ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          view.state == NoteDisplayState.recording
                              ? 'Taking notes · ${view.title}'
                              : 'Notes paused · ${view.title}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.bodyMedium?.copyWith(
                            color: theme.colorScheme.onErrorContainer,
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      NoteElapsedText(
                        view: view,
                        style: theme.textTheme.labelLarge?.copyWith(
                          color: theme.colorScheme.onErrorContainer,
                        ),
                      ),
                      Icon(
                        Icons.chevron_right,
                        color: theme.colorScheme.onErrorContainer,
                      ),
                    ],
                  ),
                ),
              ),
            ),
    );
  }
}
