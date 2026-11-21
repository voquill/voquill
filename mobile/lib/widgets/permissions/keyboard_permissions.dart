import 'dart:io';

import 'package:app/actions/remote_actions.dart';
import 'package:app/model/local_note_model.dart';
import 'package:app/store/store.dart';
import 'package:app/utils/channel_utils.dart';
import 'package:app/widgets/common/asset_video_player.dart';
import 'package:app/widgets/onboarding/onboarding_widgets.dart';
import 'package:app/widgets/permissions/permission_granted_banner.dart';
import 'package:flutter/material.dart';

class KeyboardPermissions extends StatefulWidget {
  const KeyboardPermissions({
    super.key,
    this.backButton,
    required this.nextButton,
  });

  final Widget? backButton;
  final Widget nextButton;

  @override
  State<KeyboardPermissions> createState() => _KeyboardPermissionsState();
}

class _KeyboardPermissionsState extends State<KeyboardPermissions>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _checkEnabled();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _checkEnabled();
    }
  }

  Future<void> _checkEnabled() async {
    final enabled = await isKeyboardEnabled();
    if (mounted) {
      produceAppState((draft) {
        draft.hasKeyboardPermission = enabled;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final isEnabled = useAppStore().select(
      context,
      (s) => s.hasKeyboardPermission,
    );
    // Picture in picture switches the audio session to playback, which
    // would interrupt a meeting or remote dictation using the microphone.
    final isMicrophoneInUse =
        useAppStore().select(
          context,
          (s) => s.notes.liveNote?.phase == LocalNotePhase.recording,
        ) ||
        isRemoteMicrophoneOpen;

    final button = isEnabled
        ? widget.nextButton
        : FilledButton(
            key: const ValueKey('open-keyboard-settings'),
            onPressed: openKeyboardSettings,
            child: const Text('Open settings'),
          );

    return OnboardingFormLayout(
      backButton: widget.backButton,
      actions: [
        if (isEnabled)
          const PermissionGrantedBanner(text: 'Keyboard access granted'),
        button,
      ],
      child: OnboardingBody(
        title: const Text('Keyboard access'),
        description: const Text(
          'Add Voquill as a keyboard to use voice input in any app.',
        ),
        child: Center(
          child: AssetVideoPlayer.phone(
            asset: Platform.isIOS
                ? 'assets/keyboard-perms-ios.mp4'
                : 'assets/keyboard-perms-android.mp4',
            pip: !isMicrophoneInUse,
          ),
        ),
      ),
    );
  }
}
