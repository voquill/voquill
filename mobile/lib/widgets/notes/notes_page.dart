import 'dart:async';

import 'package:app/actions/notes_actions.dart';
import 'package:app/api/notes_api.dart';
import 'package:app/model/note_model.dart';
import 'package:app/store/store.dart';
import 'package:app/utils/note_utils.dart';
import 'package:app/utils/theme_utils.dart';
import 'package:app/widgets/common/app_sliver_app_bar.dart';
import 'package:app/widgets/notes/import_transcript_dialog.dart';
import 'package:app/widgets/notes/note_ask_sheet.dart';
import 'package:app/widgets/notes/note_tile.dart';
import 'package:flutter/material.dart';
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
      });
      return;
    }
    _searchTimer = Timer(_searchDebounce, () => _search(query));
  }

  Future<void> _search(String query) async {
    final generation = ++_searchGeneration;
    setState(() => _isSearching = true);
    List<NoteSearchResult> results;
    try {
      results = await searchNotes(query);
    } on NotesApiException {
      results = const [];
    }
    if (!mounted || generation != _searchGeneration) return;
    setState(() {
      _results = results;
      _isSearching = false;
    });
  }

  Future<void> _startNew() async {
    final active = getAppState().notes.capturingNote;
    if (active != null) {
      context.push('/dashboard/notes/${active.id}');
      return;
    }
    final id = await startNewNote();
    if (id != null && mounted) context.push('/dashboard/notes/$id');
  }

  @override
  Widget build(BuildContext context) {
    final notes = useAppStore().select(context, (s) => s.notes);
    final theme = Theme.of(context);
    final list = buildNoteList(notes, query: _query);
    final hasQuery = _query.trim().isNotEmpty;
    final listedIds = list.map((v) => v.id).toSet();
    final contentMatches = _results
        .where((r) => !listedIds.contains(r.note.id))
        .map((r) => (view: buildNoteView(notes, r.note.id), snippet: r.snippet))
        .where((r) => r.view != null)
        .toList();
    final isCapturing = notes.capturingNote != null;

    return Scaffold(
      body: RefreshIndicator(
        onRefresh: () async {
          await refreshNotes();
          await syncAllNotes();
        },
        edgeOffset: 120,
        child: CustomScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            ...AppSliverAppBar(
              title: const Text('Notes'),
              actions: [
                IconButton(
                  tooltip: 'Import transcript',
                  icon: const Icon(Icons.upload_file_outlined, size: 22),
                  onPressed: () => ImportTranscriptDialog.show(context),
                ),
                IconButton(
                  tooltip: 'Ask your notes',
                  icon: const Icon(Icons.auto_awesome_outlined),
                  onPressed: () => NoteAskSheet.show(context),
                ),
              ],
            ).buildSlivers(context),
            SliverPadding(
              padding: Theming.padding.onlyHorizontal().withBottom(8),
              sliver: SliverToBoxAdapter(
                child: SearchBar(
                  controller: _searchController,
                  hintText: 'Search notes',
                  elevation: const WidgetStatePropertyAll(0),
                  leading: const Icon(Icons.search),
                  trailing: [
                    if (hasQuery)
                      IconButton(
                        icon: const Icon(Icons.close),
                        onPressed: () {
                          _searchController.clear();
                          _onQueryChanged('');
                        },
                      ),
                  ],
                  onChanged: _onQueryChanged,
                ),
              ),
            ),
            if (list.isEmpty && !hasQuery)
              SliverFillRemaining(
                hasScrollBody: false,
                child: notes.listStatus.isLoading && notes.serverNoteIds.isEmpty
                    ? const Center(child: CircularProgressIndicator())
                    : const _EmptyNotes(),
              )
            else
              SliverList.builder(
                itemCount: list.length,
                itemBuilder: (context, index) {
                  if (!hasQuery && index == list.length - 1) {
                    WidgetsBinding.instance.addPostFrameCallback(
                      (_) => loadMoreNotes(),
                    );
                  }
                  return NoteTile(view: list[index]);
                },
              ),
            if (hasQuery) ...[
              if (_isSearching || contentMatches.isNotEmpty)
                SliverPadding(
                  padding: Theming.padding.withBottom(4),
                  sliver: SliverToBoxAdapter(
                    child: Row(
                      children: [
                        Text(
                          'In your notes',
                          style: theme.textTheme.titleSmall?.copyWith(
                            color: theme.colorScheme.onSurface.withValues(
                              alpha: 0.6,
                            ),
                          ),
                        ),
                        const Spacer(),
                        if (_isSearching)
                          const SizedBox(
                            width: 14,
                            height: 14,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          ),
                      ],
                    ),
                  ),
                ),
              SliverList.builder(
                itemCount: contentMatches.length,
                itemBuilder: (context, index) => NoteTile(
                  view: contentMatches[index].view!,
                  snippet: contentMatches[index].snippet,
                ),
              ),
              if (!_isSearching && list.isEmpty && contentMatches.isEmpty)
                const SliverFillRemaining(
                  hasScrollBody: false,
                  child: Center(child: Text('No matching notes')),
                ),
            ],
            const SliverToBoxAdapter(child: SizedBox(height: 96)),
          ],
        ),
      ),
      floatingActionButton: FloatingActionButton.extended(
        heroTag: 'notes_fab',
        onPressed: _startNew,
        icon: Icon(isCapturing ? Icons.graphic_eq : Icons.mic),
        label: Text(isCapturing ? 'Back to meeting' : 'New'),
      ),
    );
  }
}

class _EmptyNotes extends StatelessWidget {
  const _EmptyNotes();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurface.withValues(alpha: 0.5);
    return Padding(
      padding: Theming.padding,
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.sticky_note_2_outlined, size: 48, color: muted),
          const SizedBox(height: 12),
          Text('No notes yet', style: theme.textTheme.titleMedium),
          const SizedBox(height: 4),
          Text(
            'Tap New when your meeting starts. Voquill records it and writes the notes for you.',
            textAlign: TextAlign.center,
            style: theme.textTheme.bodyMedium?.copyWith(color: muted),
          ),
        ],
      ),
    );
  }
}
