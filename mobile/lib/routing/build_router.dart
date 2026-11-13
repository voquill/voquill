import 'package:app/routing/guard_redirect.dart';
import 'package:app/widgets/dashboard/dashboard_page.dart';
import 'package:app/widgets/error/error_page.dart';
import 'package:app/widgets/history/history_page.dart';
import 'package:app/widgets/settings/danger_zone_page.dart';
import 'package:app/widgets/settings/dictation_language_page.dart';
import 'package:app/widgets/remote/remote_dictation_page.dart';
import 'package:app/widgets/styles/manage_styles_page.dart';
import 'package:app/widgets/error/not_found_page.dart';
import 'package:app/widgets/login/login_page.dart';
import 'package:app/widgets/notes/note_page.dart';
import 'package:app/widgets/onboarding/onboarding_page.dart';
import 'package:app/widgets/setup/setup_page.dart';
import 'package:app/widgets/splash/splash_page.dart';
import 'package:app/widgets/welcome/welcome_page.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

final rootNavigatorKey = GlobalKey<NavigatorState>();

GoRouter buildRouter({required Listenable? refreshListenable}) {
  return GoRouter(
    navigatorKey: rootNavigatorKey,
    initialLocation: '/',
    debugLogDiagnostics: false,
    redirect: (context, state) => guardRedirect(context, state),
    refreshListenable: refreshListenable,
    errorBuilder: (context, state) => const NotFoundPage(),
    routes: [
      GoRoute(
        path: '/',
        builder: (context, state) => const SplashPage(),
        name: 'splash',
      ),
      GoRoute(
        path: '/error',
        builder: (context, state) => const ErrorPage(),
        name: 'error',
      ),
      GoRoute(
        path: '/welcome',
        builder: (context, state) => const WelcomePage(),
        name: 'welcome',
      ),
      GoRoute(
        path: '/login',
        builder: (context, state) => const LoginPage(),
        name: 'login',
      ),
      GoRoute(
        path: '/onboarding',
        builder: (context, state) => const OnboardingPage(),
        name: 'onboarding',
      ),
      GoRoute(
        path: '/setup',
        builder: (context, state) => const SetupPage(),
        name: 'setup',
      ),
      GoRoute(
        path: '/dashboard',
        builder: (context, state) => const DashboardPage(),
        name: 'dashboard',
        routes: [
          GoRoute(
            path: 'history',
            builder: (context, state) => const HistoryPage(),
            name: 'history',
          ),
          GoRoute(
            path: 'manage-styles',
            builder: (context, state) => const ManageStylesPage(),
            name: 'manage-styles',
          ),
          GoRoute(
            path: 'dictation-language',
            builder: (context, state) => const DictationLanguagePage(),
            name: 'dictation-language',
          ),
          GoRoute(
            path: 'danger-zone',
            builder: (context, state) => const DangerZonePage(),
            name: 'danger-zone',
          ),
          GoRoute(
            path: 'notes/:noteId',
            builder: (context, state) =>
                NotePage(noteId: state.pathParameters['noteId']!),
            name: 'note',
          ),
          GoRoute(
            path: 'remote-dictation/:sessionId',
            builder: (context, state) => RemoteDictationPage(
              sessionId: state.pathParameters['sessionId']!,
            ),
            name: 'remote-dictation',
          ),
        ],
      ),
    ],
  );
}
