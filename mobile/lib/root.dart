import 'dart:async';

import 'package:app/utils/analytics_utils.dart';
import 'package:app/actions/app_actions.dart';
import 'package:app/actions/keyboard_actions.dart';
import 'package:app/actions/notes_actions.dart';
import 'package:app/actions/permission_actions.dart';
import 'package:app/api/counter_api.dart';
import 'package:app/flavor.dart';
import 'package:app/routing/build_router.dart';
import 'package:app/routing/route_refresher.dart';
import 'package:app/state/snackbar_state.dart';
import 'package:app/store/store.dart';
import 'package:app/theme/app_colors.dart';
import 'package:app/theme/build_theme.dart';
import 'package:app/widgets/common/unfocus_detector.dart';
import 'package:app/widgets/common/app_overlay.dart';
import 'package:app/widgets/dictate/dictation_content.dart';
import 'package:app/widgets/paywall/paywall_content.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

class Root extends StatelessWidget {
  const Root({super.key});

  @override
  Widget build(BuildContext context) {
    return StoreScope(
      child: ChangeNotifierProvider(
        create: (context) => RouteRefresher(),
        child: const App(),
      ),
    );
  }
}

class App extends StatefulWidget {
  const App({super.key});

  @override
  State<App> createState() => _AppState();
}

class _AppState extends State<App> with WidgetsBindingObserver {
  final scaffoldMessengerKey = GlobalKey<ScaffoldMessengerState>();
  late final GoRouter goRouter;
  late final StreamSubscription _authSubscription;
  late final StreamSubscription<String> _openNoteSubscription;
  late final Timer _updatePoller;
  late final Timer _refreshPoller;
  int _lastUpdateCounter = -1;

  static const _channel = MethodChannel('com.voquill.mobile/shared');

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    goRouter = buildRouter(refreshListenable: context.read<RouteRefresher>());
    goRouter.routeInformationProvider.addListener(_onRouteChanged);
    _authSubscription = listenToAuthChanges();
    _updatePoller = Timer.periodic(
      const Duration(seconds: 1),
      (_) => _checkForUpdates(),
    );
    _refreshPoller = Timer.periodic(
      const Duration(minutes: 10),
      (_) => _refreshData(),
    );
    _channel.setMethodCallHandler(_handleNativeCall);
    _openNoteSubscription = openNoteRequests.listen(
      (id) => goRouter.push('/dashboard/notes/$id'),
    );
  }

  @override
  void dispose() {
    goRouter.routeInformationProvider.removeListener(_onRouteChanged);
    WidgetsBinding.instance.removeObserver(this);
    _updatePoller.cancel();
    _refreshPoller.cancel();
    _authSubscription.cancel();
    _openNoteSubscription.cancel();
    super.dispose();
  }

  void _onRouteChanged() {
    final location = goRouter.routeInformationProvider.value.uri.path;
    trackPageView(location);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      checkPermissions();
      syncAllNotes();
    }
  }

  Future<dynamic> _handleNativeCall(MethodCall call) async {
    if (call.method == 'showDictationDialog') {
      showAppOverlay(AppOverlayType.dictation);
    } else if (call.method == 'showPaywall') {
      showAppOverlay(AppOverlayType.paywall);
    }
  }

  Future<void> _checkForUpdates() async {
    final counter = await GetAppCounterApi().call(null);
    if (counter != _lastUpdateCounter && getAppState().isLoggedIn) {
      _lastUpdateCounter = counter;
      await refreshMainData();
    }
  }

  Future<void> _refreshData() async {
    if (getAppState().isLoggedIn) {
      await refreshMainData();
    }
  }

  @override
  Widget build(BuildContext context) {
    Widget app = UnfocusDetector(
      child: MaterialApp.router(
        theme: buildLightTheme(),
        darkTheme: buildDarkTheme(),
        themeMode: ThemeMode.system,
        routerConfig: goRouter,
        scaffoldMessengerKey: scaffoldMessengerKey,
        builder: (context, child) {
          return AppOverlay(
            builder: (type) => switch (type) {
              AppOverlayType.dictation => const DictationContent(),
              AppOverlayType.paywall => const PaywallContent(),
            },
            child: child ?? const SizedBox.shrink(),
          );
        },
      ),
    );

    final color = Flavor.current.color;
    if (color != null) {
      app = Directionality(
        textDirection: TextDirection.ltr,
        child: Banner(
          message: Flavor.current.shortName,
          location: BannerLocation.topStart,
          color: color,
          child: app,
        ),
      );
    }

    return StoreListener([
      useAppStore().listen(
        (context, state) {
          context.read<RouteRefresher>().refresh();
        },
        condition: (a, b) =>
            a.status != b.status ||
            a.auth != b.auth ||
            a.isOnboarded != b.isOnboarded ||
            a.hasPermissions != b.hasPermissions,
      ),
      useAppStore().listen(
        (context, state) async {
          await syncKeyboardOnInit();
        },
        condition: (a, b) =>
            !a.status.isSuccess && b.status.isSuccess && b.isLoggedIn,
      ),
      useAppStore().listen(
        (context, state) => syncMixpanelIdentity(state),
        condition: (a, b) =>
            a.auth?.uid != b.auth?.uid ||
            a.member?.plan != b.member?.plan ||
            a.member?.isOnTrial != b.member?.isOnTrial ||
            a.user?.onboarded != b.user?.onboarded ||
            a.user?.name != b.user?.name,
      ),
      useAppStore().listen(
        (context, state) => syncTonesToKeyboard(),
        condition: (a, b) =>
            a.user?.selectedToneId != b.user?.selectedToneId ||
            a.user?.activeToneIds != b.user?.activeToneIds ||
            !mapEquals(a.toneById, b.toneById),
      ),
      useAppStore().listen(
        (context, state) => syncUserToKeyboard(),
        condition: (a, b) => a.user?.name != b.user?.name,
      ),
      useAppStore().listen(
        (context, state) => syncDictionaryToKeyboard(),
        condition: (a, b) =>
            !mapEquals(a.termById, b.termById) ||
            a.dictionary.termIds != b.dictionary.termIds,
      ),
      useAppStore().listen(
        (context, state) => syncLanguagesToKeyboard(),
        condition: (a, b) =>
            a.dictationLanguages != b.dictationLanguages ||
            a.activeDictationLanguage != b.activeDictationLanguage,
      ),
      useAppStore().listen((context, state) {
        if (state.snackbar.counter > 0) {
          final snackContext = scaffoldMessengerKey.currentContext;
          scaffoldMessengerKey.currentState?.showSnackBar(
            SnackBar(
              content: Text(state.snackbar.message, maxLines: 5),
              showCloseIcon: true,
              duration: state.snackbar.duration,
              backgroundColor: state.snackbar.type == SnackbarType.error
                  ? snackContext?.colors.error
                  : null,
            ),
          );
        }
      }, condition: (a, b) => a.snackbar.counter != b.snackbar.counter),
    ], child: app);
  }
}
