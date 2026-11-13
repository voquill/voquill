import 'dart:async';

import 'package:app/model/desktop_session_model.dart';
import 'package:app/store/store.dart';
import 'package:app/widgets/common/app_animated_shared_axis.dart';
import 'package:app/widgets/dictionary/dictionary_page.dart';
import 'package:app/widgets/home/home_page.dart';
import 'package:app/widgets/notes/active_note_banner.dart';
import 'package:app/widgets/notes/notes_page.dart';
import 'package:app/widgets/settings/settings_page.dart';
import 'package:app/widgets/styles/styles_page.dart';
import 'package:firebase_database/firebase_database.dart';
import 'package:flutter/material.dart';

const _activeThresholdMs = 20 * 60 * 1000; // 20 minutes

class DashboardPage extends StatefulWidget {
  const DashboardPage({super.key});

  @override
  State<DashboardPage> createState() => _DashboardPageState();
}

class _DashboardPageState extends State<DashboardPage> {
  int _selectedIndex = 0;
  int _previousIndex = 0;
  StreamSubscription<DatabaseEvent>? _sessionSubscription;

  @override
  void initState() {
    super.initState();
    _subscribeToSessions();
  }

  @override
  void dispose() {
    _unsubscribeFromSessions();
    super.dispose();
  }

  void _subscribeToSessions() {
    final uid = getAppState().auth?.uid;
    if (uid == null) return;

    final sessionsRef = FirebaseDatabase.instance.ref('session/$uid');
    _sessionSubscription = sessionsRef.onValue.listen((event) {
      final snapshot = event.snapshot;
      final sessions = <String, DesktopSession>{};

      if (snapshot.value != null) {
        final data = Map<String, dynamic>.from(snapshot.value as Map);
        final now = DateTime.now().millisecondsSinceEpoch;

        for (final entry in data.entries) {
          final value = Map<String, dynamic>.from(entry.value as Map);
          final lastActive = value['lastActive'] as int? ?? 0;
          if (now - lastActive > _activeThresholdMs) continue;

          sessions[entry.key] = DesktopSession(
            id: entry.key,
            name: value['name'] as String? ?? 'Unknown',
            lastActive: lastActive,
            type: value['type'] as String?,
          );
        }
      }

      produceAppState((draft) {
        draft.desktopSessionById = sessions;
      });
    });
  }

  void _unsubscribeFromSessions() {
    _sessionSubscription?.cancel();
    _sessionSubscription = null;
    produceAppState((draft) {
      draft.desktopSessionById = {};
    });
  }

  static const _pages = <Widget>[
    HomePage(key: Key('home')),
    NotesPage(key: Key('notes')),
    DictionaryPage(key: Key('dictionary')),
    StylesPage(key: Key('styles')),
    SettingsPage(key: Key('settings')),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: AppAnimatedSharedAxis(
        reverse: _previousIndex > _selectedIndex,
        child: _pages[_selectedIndex],
      ),
      bottomNavigationBar: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // The Notes tab pins the recording itself.
          if (_pages[_selectedIndex] is! NotesPage) const ActiveNoteBanner(),
          NavigationBar(
            selectedIndex: _selectedIndex,
            onDestinationSelected: (index) {
              setState(() {
                _previousIndex = _selectedIndex;
                _selectedIndex = index;
              });
            },
            destinations: const [
              NavigationDestination(
                icon: Icon(Icons.home_outlined),
                selectedIcon: Icon(Icons.home),
                label: 'Home',
              ),
              NavigationDestination(
                icon: Icon(Icons.sticky_note_2_outlined),
                selectedIcon: Icon(Icons.sticky_note_2),
                label: 'Notes',
              ),
              NavigationDestination(
                icon: Icon(Icons.book_outlined),
                selectedIcon: Icon(Icons.book),
                label: 'Dictionary',
              ),
              NavigationDestination(
                icon: Icon(Icons.palette_outlined),
                selectedIcon: Icon(Icons.palette),
                label: 'Styles',
              ),
              NavigationDestination(
                icon: Icon(Icons.settings_outlined),
                selectedIcon: Icon(Icons.settings),
                label: 'Settings',
              ),
            ],
          ),
        ],
      ),
    );
  }
}
