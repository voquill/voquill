import 'dart:async';

import 'package:app/actions/notes_actions.dart';
import 'package:app/api/notes_api.dart';
import 'package:app/model/note_model.dart';
import 'package:app/store/store.dart';
import 'package:app/theme/app_colors.dart';
import 'package:app/utils/note_utils.dart';
import 'package:app/utils/theme_utils.dart';
import 'package:app/widgets/common/app_sliver_app_bar.dart';
import 'package:app/widgets/notes/ask_dock.dart';
import 'package:app/widgets/notes/import_transcript_dialog.dart';
import 'package:app/widgets/notes/note_tile.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

const _searchDebounce = Duration(milliseconds: 400);

class NotesPage extends StatefulWidget {
  const NotesPage({super.key});

  @override
  State<NotesPage> createState() => _NotesPageState();
}

class _NotesPageState extends State<NotesPage> {
  final _searchController = TextEditingController();
  Timer? _searchTimer;
  String _query = '';
  List<NoteSearchResult> _results = const [];
  bool _isSearching = false;
  bool _didSearchFail = false;
  int _searchGeneration = 0;

  @override
  void initState() {
    super.initState();
    refreshNotes();
  }

  @override
  void dispose() {
    _searchTimer?.cancel();
    _searchController.dispose();
    super.dispose();
  }

  void _onQueryChanged(String value) {
    setState(() => _query = value);
    _searchTimer?.cancel();
    final query = value.trim();
    if (query.isEmpty) {
      setState(() {
        _results = const [];
        _isSearching = false;
        _didSearchFail = false;
      });
      return;
    }
    _searchTimer = Timer(_searchDebounce, () => _search(query));
  }

  Future<void> _search(String query) async {
    final generation = ++_searchGeneration;
    setState(() => _isSearching = true);
    List<NoteSearchResult> results;
    var didFail = false;
    try {
      results = await searchNotes(query);
    } on NotesApiException {
      results = const [];
      didFail = true;
    }
    if (!mounted || generation != _searchGeneration) return;
    setState(() {
      _results = results;
      _isSearching = false;
      _didSearchFail = didFail;
    });
  }

  Future<void> _startNew() async {
    final active = getAppState().notes.capturingNote;
    if (active != null) {
      context.push('/dashboard/notes/${active.id}');
      return;
    }
    HapticFeedback.mediumImpact();
    final id = await startNewNote();
    if (id != null && mounted) context.push('/dashboard/notes/$id');
  }

  @override
  Widget build(BuildContext context) {
    final notes = useAppStore().select(context, (s) => s.notes);
    final now = DateTime.now();
    final hasQuery = _query.trim().isNotEmpty;
    final all = buildNoteList(notes, query: _query);
    final capturing = all.where((v) => v.state.isCapturing).toList();
    final entries = groupNotesByDay(
      all.where((v) => !v.state.isCapturing).toList(),
      now,
    );
    final listedIds = all.map((v) => v.id).toSet();
    final contentMatches = _results
        .where((r) => !listedIds.contains(r.note.id))
        .map((r) => (view: buildNoteView(notes, r.note.id), snippet: r.snippet))
        .where((r) => r.view != null)
        .toList();
    final isEmpty = all.isEmpty && !hasQuery;

    return Scaffold(
      body: Column(
        children: [
          Expanded(
            child: RefreshIndicator(
              onRefresh: () async {
                await refreshNotes();
                await syncAllNotes();
              },
              edgeOffset: 120,
              child: NotificationListener<ScrollNotification>(
                onNotification: (notification) {
                  if (notification.metrics.extentAfter < 600) loadMoreNotes();
                  return false;
                },
                child: CustomScrollView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  slivers: [
                    ...AppSliverAppBar(
                      title: const Text('Notes'),
                      actions: [
                        IconButton(
                          tooltip: 'Import transcript',
                          icon: const Icon(Icons.upload_file_outlined),
                          onPressed: () => ImportTranscriptDialog.show(context),
                        ),
                      ],
                    ).buildSlivers(context),
                    if (!isEmpty || hasQuery)
                      SliverPadding(
                        padding: Theming.padding.onlyHorizontal().withBottom(8),
                        sliver: SliverToBoxAdapter(
                          child: _SearchField(
                            controller: _searchController,
                            hasQuery: hasQuery,
                            onChanged: _onQueryChanged,
                          ),
                        ),
                      ),
                    if (notes.isOffline && !isEmpty)
                      const SliverToBoxAdapter(child: _OfflineNotice()),
                    if (capturing.isNotEmpty) ...[
                      const SliverToBoxAdapter(
                        child: _DayHeader(label: 'Recording now'),
                      ),
                      SliverList.list(
                        children: [
                          for (final (i, view) in capturing.indexed)
                            NoteTile(
                              view: view,
                              isFirst: i == 0,
                              isLast: i == capturing.length - 1,
                            ),
                        ],
                      ),
                    ],
                    if (isEmpty)
                      SliverFillRemaining(
                        hasScrollBody: false,
                        child:
                            !notes.isInitialized || notes.listStatus.isLoading
                            ? const Center(child: CircularProgressIndicator())
                            : notes.listStatus.isError
                            ? const _EmptyState(
                                icon: Icons.cloud_off_outlined,
                                title: "Couldn't load your notes",
                                body:
                                    'Check your connection, then pull down to try again.',
                              )
                            : const _EmptyState(
                                icon: Icons.sticky_note_2_outlined,
                                title: 'Your meetings, written up',
                                body:
                                    'Tap New when a meeting starts. Voquill records it, then writes clean notes and a transcript you can search and ask about.',
                              ),
                      )
                    else
                      SliverList.builder(
                        itemCount: entries.length,
                        itemBuilder: (context, index) =>
                            switch (entries[index]) {
                              NoteDayHeader(:final label) => _DayHeader(
                                label: label,
                              ),
                              NoteRow(
                                :final view,
                                :final isFirstInDay,
                                :final isLastInDay,
                              ) =>
                                NoteTile(
                                  view: view,
                                  isFirst: isFirstInDay,
                                  isLast: isLastInDay,
                                ),
                            },
                      ),
                    if (hasQuery) ...[
                      if (_isSearching || contentMatches.isNotEmpty)
                        _DayHeader(
                          label: 'In your notes',
                          trailing: _isSearching
                              ? const SizedBox(
                                  width: 14,
                                  height: 14,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                )
                              : null,
                        ).sliver(),
                      SliverList.builder(
                        itemCount: contentMatches.length,
                        itemBuilder: (context, index) => NoteTile(
                          view: contentMatches[index].view!,
                          snippet: contentMatches[index].snippet,
                          isFirst: index == 0,
                          isLast: index == contentMatches.length - 1,
                        ),
                      ),
                      if (!_isSearching &&
                          all.isEmpty &&
                          contentMatches.isEmpty)
                        SliverFillRemaining(
                          hasScrollBody: false,
                          child: _EmptyState(
                            icon: Icons.search_off,
                            title: 'No notes match "${_query.trim()}"',
                            body: _didSearchFail
                                ? 'Only titles were searched because you are offline.'
                                : 'Try other words, or ask the question below.',
                          ),
                        ),
                    ],
                    if (!hasQuery && notes.nextCursor != null)
                      SliverToBoxAdapter(
                        child: Padding(
                          padding: Theming.padding,
                          child: Center(
                            child: notes.loadMoreStatus.isError
                                ? TextButton(
                                    onPressed: () => loadMoreNotes(retry: true),
                                    child: const Text('Load more'),
                                  )
                                : const SizedBox(
                                    width: 20,
                                    height: 20,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                    ),
                                  ),
                          ),
                        ),
                      ),
                    const SliverToBoxAdapter(child: SizedBox(height: 16)),
                  ],
                ),
              ),
            ),
          ),
          AskDock(
            trailing: _NewButton(
              isRecording: capturing.isNotEmpty,
              onPressed: notes.isInitialized && !notes.isRecorderBusy
                  ? _startNew
                  : null,
            ),
          ),
        ],
      ),
    );
  }
}

class _SearchField extends StatelessWidget {
  const _SearchField({
    required this.controller,
    required this.hasQuery,
    required this.onChanged,
  });

  final TextEditingController controller;
  final bool hasQuery;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      onChanged: onChanged,
      textInputAction: TextInputAction.search,
      decoration: InputDecoration(
        hintText: 'Search notes',
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(vertical: 14),
        prefixIcon: const Icon(Icons.search),
        suffixIcon: hasQuery
            ? IconButton(
                tooltip: 'Clear search',
                icon: const Icon(Icons.close),
                onPressed: () {
                  controller.clear();
                  onChanged('');
                },
              )
            : null,
      ),
    );
  }
}

/// The list's primary action next to the Ask box: start a meeting, or get
/// back to the one being recorded.
class _NewButton extends StatelessWidget {
  const _NewButton({required this.isRecording, required this.onPressed});

  final bool isRecording;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Semantics(
      label: isRecording ? 'Back to the meeting' : 'New meeting',
      button: true,
      excludeSemantics: true,
      child: Tooltip(
        message: isRecording ? 'Back to the meeting' : 'New meeting',
        child: FilledButton(
          onPressed: onPressed,
          style: FilledButton.styleFrom(
            minimumSize: const Size(64, 52),
            padding: EdgeInsets.zero,
            backgroundColor: isRecording ? colors.error : null,
            foregroundColor: isRecording ? colors.onError : null,
          ),
          child: Icon(isRecording ? Icons.graphic_eq : Icons.mic, size: 26),
        ),
      ),
    );
  }
}

class _DayHeader extends StatelessWidget {
  const _DayHeader({required this.label, this.trailing});

  final String label;
  final Widget? trailing;

  Widget sliver() => SliverToBoxAdapter(child: this);

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: Theming.padding.withTop(20).withBottom(8),
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
          ?trailing,
        ],
      ),
    );
  }
}

class _OfflineNotice extends StatelessWidget {
  const _OfflineNotice();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = context.colors.onLevel0.withValues(alpha: 0.6);
    return Padding(
      padding: Theming.padding.withTop(4).withBottom(0),
      child: Row(
        children: [
          Icon(Icons.cloud_off_outlined, size: 18, color: muted),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              "You're offline. Recording still works; notes sync when you're back.",
              style: theme.textTheme.bodySmall?.copyWith(color: muted),
            ),
          ),
        ],
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({
    required this.icon,
    required this.title,
    required this.body,
  });

  final IconData icon;
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = context.colors.onLevel0.withValues(alpha: 0.6);
    return Padding(
      padding: Theming.padding.copyWith(left: 32, right: 32),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(icon, size: 48, color: muted),
          const SizedBox(height: 16),
          Text(
            title,
            style: theme.textTheme.titleMedium,
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 8),
          Text(
            body,
            textAlign: TextAlign.center,
            style: theme.textTheme.bodyMedium?.copyWith(color: muted),
          ),
        ],
      ),
    );
  }
}
