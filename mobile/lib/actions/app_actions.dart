import 'dart:async';

import 'package:app/actions/language_actions.dart';
import 'package:app/actions/notes_actions.dart';
import 'package:app/actions/permission_actions.dart';
import 'package:app/actions/revenue_cat_actions.dart';
import 'package:app/actions/styles_actions.dart';
import 'package:app/actions/transcription_actions.dart';
import 'package:app/api/config_api.dart';
import 'package:app/api/member_api.dart';
import 'package:app/api/user_api.dart';
import 'package:app/model/auth_user_model.dart';
import 'package:app/model/common_model.dart';
import 'package:app/store/store.dart';
import 'package:app/utils/channel_utils.dart';
import 'package:app/utils/log_utils.dart';
import 'package:firebase_auth/firebase_auth.dart';

final _logger = createNamedLogger('app_actions');

Future<void> refreshMainData() async {
  await Future.wait([
    loadTranscriptions(),
    loadCurrentUser(),
    loadCurrentMember(),
    loadConfig(),
    loadStyles(),
    loadDictationLanguages(),
  ]);
}

StreamSubscription<User?> listenToAuthChanges() {
  return FirebaseAuth.instance.authStateChanges().listen((firebaseUser) async {
    final currentAuth = getAppState().auth;
    final isInitial = getAppState().status.isLoading;

    if (firebaseUser != null) {
      if (currentAuth?.uid != firebaseUser.uid) {
        produceAppState((draft) {
          draft.auth = AuthUser(
            uid: firebaseUser.uid,
            email: firebaseUser.email,
          );
        });
        await loginRevenueCat(firebaseUser.uid);
        await refreshMainData();
        unawaited(initializeNotesForUser(firebaseUser.uid));
      }
      syncKeyboardAuth();
    } else {
      if (currentAuth != null) {
        await disposeNotes();
        await logoutRevenueCat();
        produceAppState((draft) {
          draft.auth = null;
          draft.user = null;
          draft.member = null;
        });
      }
      clearKeyboardAuth();
    }

    if (isInitial) {
      await checkPermissions();
      produceAppState((draft) {
        draft.status = ActionStatus.success;
      });
    }
  });
}

Future<void> loadCurrentUser() async {
  try {
    final output = await GetMyUserApi().call(null);
    produceAppState((draft) {
      draft.user = output.user;
    });
  } catch (e) {
    _logger.w('Failed to load user (may not exist yet)', e);
  }
}

Future<void> loadCurrentMember() async {
  try {
    final output = await GetMyMemberApi().call(null);
    produceAppState((draft) {
      draft.member = output.member;
    });
  } catch (e) {
    _logger.w('Failed to load member', e);
  }
}

Future<void> loadConfig() async {
  try {
    final output = await GetFullConfigApi().call(null);
    produceAppState((draft) {
      draft.config = output.config;
    });
  } catch (e) {
    _logger.w('Failed to load config', e);
  }
}

Future<void> tryInitializeMember() async {
  try {
    await TryInitializeMemberApi().call(null);
  } catch (e) {
    _logger.w('Failed to initialize member', e);
  }
}
