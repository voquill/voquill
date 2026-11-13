import 'package:app/actions/notes_actions.dart';
import 'package:app/theme/app_colors.dart';
import 'package:app/utils/note_utils.dart';
import 'package:app/utils/theme_utils.dart';
import 'package:app/widgets/common/app_list_tile.dart';
import 'package:app/widgets/notes/delete_note_dialog.dart';
import 'package:app/widgets/notes/note_elapsed_text.dart';
import 'package:app/widgets/notes/note_state_text.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

/// One note in the grouped list: title, a second line (length and state, a
/// live timer while recording, or the search snippet) and the time. Rows of
/// one day share a rounded card like the app's other grouped lists.
class NoteTile extends StatelessWidget {
  const NoteTile({
    super.key,
    required this.view,
    this.snippet,
    this.isFirst = true,
    this.isLast = true,
  });

  final NoteView view;
  final String? snippet;
  final bool isFirst;
  final bool isLast;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = context.colors;
    final muted = theme.textTheme.bodyMedium?.copyWith(
      color: colors.onLevel1.withValues(alpha: 0.6),
    );
    final needsAttention =
        view.state == NoteDisplayState.failed ||
        view.failedSegmentError != null;

    final Widget secondLine;
    if (snippet != null) {
      secondLine = Text(
        snippet!,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: muted,
      );
    } else if (view.state.isCapturing) {
      secondLine = Row(
        children: [
          if (view.state == NoteDisplayState.recording) ...[
            const LiveDot(),
            const SizedBox(width: 6),
          ],
          Text(
            view.state == NoteDisplayState.recording
                ? 'Recording · '
                : 'Paused · ',
            style: muted,
          ),
          NoteElapsedText(view: view, style: muted),
        ],
      );
    } else {
      secondLine = Text(
        noteStatusLine(view),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: needsAttention ? muted?.copyWith(color: colors.error) : muted,
      );
    }

    final radius = Theming.radius;
    final tiles = applyColumnListTheme(
      context: context,
      backgroundColor: colors.level1,
      topRadius: isFirst ? radius : Radius.zero,
      bottomRadius: isLast ? radius : Radius.zero,
      children: [
        Semantics(
          button: true,
          child: GestureDetector(
            onLongPress: () async {
              if (await confirmDeleteNote(context, title: view.title)) {
                deleteNote(view.id);
              }
            },
            child: AppListTile(
              onTap: () => context.push('/dashboard/notes/${view.id}'),
              title: Text(
                view.title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              subtitle: secondLine,
              trailing: Text(formatNoteTime(view.createdAt), style: muted),
            ),
          ),
        ),
      ],
    );

    return Padding(
      padding: Theming.padding.onlyHorizontal(),
      child: Column(children: [tiles.single, if (!isLast) const Divider()]),
    );
  }
}
