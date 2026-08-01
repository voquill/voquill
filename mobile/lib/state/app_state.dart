import 'package:app/model/auth_user_model.dart';
import 'package:app/model/common_model.dart';
import 'package:app/model/desktop_session_model.dart';
import 'package:app/model/config_model.dart';
import 'package:app/model/keyboard/keyboard.dart';
import 'package:app/model/member_model.dart';
import 'package:app/model/session_history_entry.dart';
import 'package:app/model/term_model.dart';
import 'package:app/model/tone_model.dart';
import 'package:app/model/transcription_model.dart';
import 'package:app/model/user_model.dart';
import 'package:app/state/dictionary_state.dart';
import 'package:app/state/onboarding_state.dart';
import 'package:app/state/remote_state.dart';
import 'package:app/state/snackbar_state.dart';
import 'package:app/state/styles_state.dart';
import 'package:draft/draft.dart';
import 'package:equatable/equatable.dart';

part 'app_state.draft.dart';

@draft
class AppState with EquatableMixin {
  final ActionStatus status;
  final String? error;
  final List<String> sortedTranscriptionIds;

  final AuthUser? auth;
  final User? user;
  final Member? member;
  final FullConfig? config;

  final Map<String, Term> termById;
  final Map<String, Tone> toneById;
  final Map<String, Transcription> transcriptionById;
  final Map<String, DesktopSession> desktopSessionById;
  final Map<String, SessionHistoryEntry> sessionHistoryEntryById;

  final SnackbarState snackbar;
  final OnboardingState onboarding;
  final DictionaryState dictionary;
  final StylesState styles;
  final RemoteState remote;

  final List<String> dictationLanguages;
  final String? activeDictationLanguage;
  final Map<String, KeyboardLayoutModel> keyboardLayoutsByLanguage;
  final String keyboardToolbarActiveMode;
  final List<String> keyboardToolbarVisibleActions;

  final bool hasMicrophonePermission;
  final bool hasKeyboardPermission;

  const AppState({
    this.status = ActionStatus.loading,
    this.error,
    this.auth,
    this.user,
    this.member,
    this.config,
    this.termById = const {},
    this.toneById = const {},
    this.transcriptionById = const {},
    this.desktopSessionById = const {},
    this.sessionHistoryEntryById = const {},
    this.sortedTranscriptionIds = const [],
    this.snackbar = const SnackbarState(),
    this.onboarding = const OnboardingState(),
    this.dictionary = const DictionaryState(),
    this.styles = const StylesState(),
    this.remote = const RemoteState(),
    this.dictationLanguages = const ['en'],
    this.activeDictationLanguage,
    this.keyboardLayoutsByLanguage = const {},
    this.keyboardToolbarActiveMode = 'Auto',
    this.keyboardToolbarVisibleActions = const [
      'startStop',
      'language',
      'mode',
    ],
    this.hasMicrophonePermission = false,
    this.hasKeyboardPermission = false,
  });

  bool get isLoggedIn => auth != null;
  bool get isOnboarded => user?.onboarded ?? false;
  bool get hasPermissions => hasMicrophonePermission && hasKeyboardPermission;

  @override
  List<Object?> get props => [
    status,
    error,
    auth,
    user,
    member,
    config,
    termById,
    toneById,
    transcriptionById,
    desktopSessionById,
    sessionHistoryEntryById,
    sortedTranscriptionIds,
    snackbar,
    onboarding,
    dictionary,
    styles,
    remote,
    dictationLanguages,
    activeDictationLanguage,
    keyboardLayoutsByLanguage,
    keyboardToolbarActiveMode,
    keyboardToolbarVisibleActions,
    hasMicrophonePermission,
    hasKeyboardPermission,
  ];
}
