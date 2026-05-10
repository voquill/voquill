import 'package:draft/draft.dart';
import 'package:equatable/equatable.dart';
import 'package:json_annotation/json_annotation.dart';

part 'tone_model.g.dart';
part 'tone_model.draft.dart';

class SharedTone {
  final String name;
  final String promptTemplate;

  const SharedTone({required this.name, required this.promptTemplate});

  Map<String, String> toMap() => {
    'name': name,
    'promptTemplate': promptTemplate,
  };
}

class SharedTerm {
  final String sourceValue;
  final String destinationValue;
  final bool isReplacement;

  const SharedTerm({
    required this.sourceValue,
    required this.destinationValue,
    required this.isReplacement,
  });

  Map<String, dynamic> toMap() => {
    'sourceValue': sourceValue,
    'destinationValue': destinationValue,
    'isReplacement': isReplacement,
  };
}

@JsonSerializable()
@draft
class Tone with EquatableMixin {
  final String id;
  final String name;
  final String promptTemplate;
  final bool isSystem;
  final num createdAt;
  final num sortOrder;
  final bool? isGlobal;
  final bool? isDeprecated;
  final bool? shouldDisablePostProcessing;

  const Tone({
    required this.id,
    required this.name,
    required this.promptTemplate,
    required this.isSystem,
    required this.createdAt,
    required this.sortOrder,
    this.isGlobal,
    this.isDeprecated,
    this.shouldDisablePostProcessing,
  });

  factory Tone.fromJson(Map<String, dynamic> json) => _$ToneFromJson(json);
  Map<String, dynamic> toJson() => _$ToneToJson(this);

  @override
  List<Object?> get props => [
    id,
    name,
    promptTemplate,
    isSystem,
    createdAt,
    sortOrder,
    isGlobal,
    isDeprecated,
    shouldDisablePostProcessing,
  ];
}
