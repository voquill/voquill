import 'package:equatable/equatable.dart';

/// All action identifiers that can appear in the toolbar.
// Actions that may appear in the toolbar or overflow strip.
// tone, settings, help are planned for future native screens.
const _knownActions = [
  'startStop', 'language', 'mode',
  'addToDictionary', 'tone', 'settings', 'help',
];

/// Payload model for the keyboard toolbar, describing which actions are
/// visible and what dictation mode is active.
class KeyboardToolbarModel with EquatableMixin {
  final List<String> visibleActions;
  final String activeMode;

  const KeyboardToolbarModel({
    required this.visibleActions,
    required this.activeMode,
  });

  factory KeyboardToolbarModel.standard() {
    return const KeyboardToolbarModel(
      visibleActions: ['startStop', 'language', 'mode'],
      activeMode: 'Auto',
    );
  }

  factory KeyboardToolbarModel.fromJson(Map<String, dynamic> json) {
    return KeyboardToolbarModel(
      visibleActions: List<String>.from(json['visibleActions'] as List),
      activeMode: json['activeMode'] as String,
    );
  }

  /// Returns known actions that are not already shown in [visibleActions].
  List<String> get overflowActions =>
      _knownActions.where((a) => !visibleActions.contains(a)).toList();

  Map<String, dynamic> toJson() => {
    'visibleActions': visibleActions,
    'activeMode': activeMode,
    'overflowActions': overflowActions,
  };

  @override
  List<Object?> get props => [visibleActions, activeMode];
}
