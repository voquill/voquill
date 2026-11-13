import 'package:app/actions/notes_actions.dart';
import 'package:app/utils/date_utils.dart';
import 'package:app/utils/note_utils.dart';
import 'package:app/widgets/common/app_list_tile.dart';
import 'package:app/widgets/notes/delete_note_dialog.dart';
import 'package:app/widgets/notes/note_elapsed_text.dart';
import 'package:app/widgets/notes/note_state_label.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

class NoteTile extends StatelessWidget {
  const NoteTile({super.key, required this.view, this.snippet});

  final NoteView view;

  /// Search match shown under the title.
  final String? snippet;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final subtitleStyle = theme.textTheme.bodyMedium?.copyWith(
      color: theme.colorScheme.onSurface.withValues(alpha: 0.6),
    );

    return GestureDetector(
      onLongPress: () async {
        if (await confirmDeleteNote(context, title: view.title)) {
          deleteNote(view.id);
        }
      },
      child: AppListTile(
        onTap: () => context.push('/dashboard/notes/${view.id}'),
        title: Text(view.title, maxLines: 1, overflow: TextOverflow.ellipsis),
        subtitle: Row(
          children: [
            Text(formatRelativeDate(view.createdAt), style: subtitleStyle),
            if (!view.state.isCapturing &&
                view.durationMs(DateTime.now()) > 0) ...[
              Text(' · ', style: subtitleStyle),
              NoteElapsedText(view: view, style: subtitleStyle),
            ],
          ],
        ),
        footer: snippet == null
            ? null
            : Text(snippet!, maxLines: 2, overflow: TextOverflow.ellipsis),
        trailing: NoteStateLabel(view: view),
      ),
    );
  }
}
