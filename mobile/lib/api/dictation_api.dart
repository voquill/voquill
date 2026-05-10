import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:app/actions/ai_settings_actions.dart';
import 'package:app/api/ai_api.dart';
import 'package:app/flavor.dart';
import 'package:app/model/api_key_model.dart';
import 'package:app/model/firebase_model.dart';
import 'package:app/utils/audio_utils.dart';
import 'package:app/utils/log_utils.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:http/http.dart' as http;

final _logger = createNamedLogger('dictation_api');
const _defaultDictationIntent = {'kind': 'dictation', 'format': 'clean'};

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

class DictationTranscriptEvent {
  final String text;
  final String authoritativeText;
  final bool isAuthoritative;
  final bool isFinal;
  final Map<String, dynamic> intent;

  const DictationTranscriptEvent({
    required this.text,
    String? authoritativeText,
    this.isAuthoritative = false,
    this.isFinal = false,
    Map<String, dynamic>? intent,
  }) : authoritativeText = authoritativeText ?? text,
       intent = intent ?? _defaultDictationIntent;
}

class DictationResult {
  final String text;
  final String authoritativeText;
  final bool isAuthoritative;
  final bool isFinalized;
  final Map<String, dynamic> dictationIntent;
  final String? source;
  final int? durationMs;

  const DictationResult({
    required this.text,
    String? authoritativeText,
    this.isAuthoritative = true,
    this.isFinalized = true,
    Map<String, dynamic>? dictationIntent,
    this.source,
    this.durationMs,
  }) : authoritativeText = authoritativeText ?? text,
       dictationIntent = dictationIntent ?? _defaultDictationIntent;
}

// ---------------------------------------------------------------------------
// Abstract session
// ---------------------------------------------------------------------------

abstract class DictationSession {
  Future<void> start({
    required int sampleRate,
    List<String> glossary = const [],
    String? language,
  });

  void sendAudio(Uint8List pcm16Bytes);

  Future<DictationResult> finalize({String? prompt, String? systemPrompt});

  Stream<DictationTranscriptEvent> get transcriptEvents;
  Stream<String> get partialTranscripts;

  void dispose();
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

Future<DictationSession> createDictationSession() async {
  final mode = await getTranscriptionMode();
  if (mode == AiMode.api) {
    final keyId = await getSelectedTranscriptionKeyId();
    if (keyId != null) {
      final keys = await loadApiKeys();
      final key = keys.where((k) => k.id == keyId).firstOrNull;
      if (key != null && key.provider.supportsTranscription) {
        final apiKeyValue = await getApiKeyValue(keyId);
        if (apiKeyValue != null || key.provider.isApiKeyOptional) {
          return ByokDictationSession(
            apiKey: apiKeyValue ?? '',
            provider: key.provider,
            baseUrl: key.baseUrl,
            model: key.transcriptionModel,
            azureRegion: key.azureRegion,
          );
        }
      }
    }
  }

  if (Flavor.current.isEmulators) {
    return CloudFunctionDictationSession();
  }

  return CloudDictationSession();
}

// ---------------------------------------------------------------------------
// Cloud WebSocket streaming session (dev / prod)
// ---------------------------------------------------------------------------

class CloudDictationSession implements DictationSession {
  static const _url = 'wss://api.voquill.com/v1/dictation';

  WebSocket? _ws;
  bool _isReady = false;
  bool _isDisposed = false;
  final List<Uint8List> _bufferedChunks = [];
  Completer<void>? _readyCompleter;
  Completer<DictationResult>? _finalizeCompleter;
  Timer? _finalizeTimeout;
  String _committedTranscript = '';
  final _eventController = StreamController<DictationTranscriptEvent>.broadcast();

  @override
  Stream<DictationTranscriptEvent> get transcriptEvents => _eventController.stream;

  @override
  Stream<String> get partialTranscripts =>
      transcriptEvents.map((event) => event.text);

  @override
  Future<void> start({
    required int sampleRate,
    List<String> glossary = const [],
    String? language,
  }) async {
    final user = FirebaseAuth.instance.currentUser;
    if (user == null) throw StateError('Not authenticated');

    final idToken = await user.getIdToken();
    _readyCompleter = Completer<void>();

    _ws = await WebSocket.connect(_url);
    _ws!.listen(_onMessage, onError: _onError, onDone: _onDone);

    _ws!.add(jsonEncode({'type': 'auth', 'idToken': idToken}));

    await _readyCompleter!.future.timeout(
      const Duration(seconds: 10),
      onTimeout: () => throw TimeoutException('Dictation server not ready'),
    );

    _ws!.add(
      jsonEncode({
        'type': 'config',
        'sampleRate': sampleRate,
        'glossary': glossary,
        if (language != null) 'language': language,
      }),
    );

    _readyCompleter = Completer<void>();
    await _readyCompleter!.future.timeout(
      const Duration(seconds: 10),
      onTimeout: () => throw TimeoutException('Dictation config not accepted'),
    );

    _isReady = true;

    for (final chunk in _bufferedChunks) {
      _ws!.add(pcm16ToFloat32Bytes(chunk));
    }
    _bufferedChunks.clear();
  }

  @override
  void sendAudio(Uint8List pcm16Bytes) {
    if (_isDisposed) return;

    if (_isReady && _ws != null) {
      _ws!.add(pcm16ToFloat32Bytes(pcm16Bytes));
    } else {
      _bufferedChunks.add(pcm16Bytes);
    }
  }

  @override
  Future<DictationResult> finalize({
    String? prompt,
    String? systemPrompt,
  }) async {
    if (_ws == null || _isDisposed) {
      return DictationResult(
        text: _committedTranscript,
        authoritativeText: _committedTranscript,
        isAuthoritative: _committedTranscript.isNotEmpty,
        isFinalized: _committedTranscript.isNotEmpty,
      );
    }

    _finalizeCompleter = Completer<DictationResult>();

    _ws!.add(
      jsonEncode({
        'type': 'finalize',
        if (prompt != null) 'prompt': prompt,
        if (systemPrompt != null) 'systemPrompt': systemPrompt,
      }),
    );

    final timeoutDuration = prompt != null
        ? const Duration(seconds: 30)
        : const Duration(seconds: 15);

    _finalizeTimeout = Timer(timeoutDuration, () {
      if (!(_finalizeCompleter?.isCompleted ?? true)) {
        _logger.w('Finalize timed out, returning committed transcript');
        _finalizeCompleter!.complete(
          DictationResult(
            text: _committedTranscript,
            authoritativeText: _committedTranscript,
            isAuthoritative: _committedTranscript.isNotEmpty,
            isFinalized: _committedTranscript.isNotEmpty,
          ),
        );
      }
    });

    return _finalizeCompleter!.future;
  }

  void _onMessage(dynamic raw) {
    if (raw is! String) return;

    final msg = jsonDecode(raw) as Map<String, dynamic>;
    final type = msg['type'] as String?;

    switch (type) {
      case 'authenticated':
      case 'ready':
        _readyCompleter?.complete();
        _readyCompleter = null;
        break;

      case 'partial_transcript':
        final text = msg['text'] as String? ?? '';
        final isFinal = msg['is_final'] as bool? ?? false;
        if (isFinal && text.isNotEmpty) {
          _committedTranscript = text;
        }
        final authoritativeText = _committedTranscript.isNotEmpty
            ? _committedTranscript
            : text;
        _eventController.add(
          DictationTranscriptEvent(
            text: text,
            authoritativeText: authoritativeText,
            isAuthoritative: isFinal,
            isFinal: isFinal,
          ),
        );
        break;

      case 'transcript':
        _finalizeTimeout?.cancel();
        final result = DictationResult(
          text: msg['text'] as String? ?? _committedTranscript,
          authoritativeText: msg['text'] as String? ?? _committedTranscript,
          isAuthoritative: true,
          isFinalized: true,
          source: msg['source'] as String?,
          durationMs: msg['durationMs'] as int?,
        );
        if (!(_finalizeCompleter?.isCompleted ?? true)) {
          _finalizeCompleter!.complete(result);
        }
        break;

      case 'error':
        final message = msg['message'] as String? ?? 'Unknown error';
        _logger.e('Dictation error: $message');
        if (!(_readyCompleter?.isCompleted ?? true)) {
          _readyCompleter!.completeError(Exception(message));
        }
        if (!(_finalizeCompleter?.isCompleted ?? true)) {
          _finalizeCompleter!.completeError(Exception(message));
        }
        break;
    }
  }

  void _onError(dynamic error) {
    _logger.e('WebSocket error: $error');
    _completeWithRecovery();
  }

  void _onDone() {
    _logger.i('WebSocket closed');
    _completeWithRecovery();
  }

  void _completeWithRecovery() {
    if (!(_readyCompleter?.isCompleted ?? true)) {
      _readyCompleter!.completeError(
        Exception('Connection closed before ready'),
      );
    }
    if (!(_finalizeCompleter?.isCompleted ?? true)) {
      _finalizeCompleter!.complete(
        DictationResult(
          text: _committedTranscript,
          authoritativeText: _committedTranscript,
          isAuthoritative: _committedTranscript.isNotEmpty,
          isFinalized: _committedTranscript.isNotEmpty,
        ),
      );
    }
  }

  @override
  void dispose() {
    _isDisposed = true;
    _finalizeTimeout?.cancel();
    _eventController.close();
    _ws?.close().catchError((_) {});
    _ws = null;
    _bufferedChunks.clear();
  }
}

// ---------------------------------------------------------------------------
// Cloud Function batch session (emulators)
// ---------------------------------------------------------------------------

class CloudFunctionDictationSession implements DictationSession {
  final _audioChunks = <Uint8List>[];
  int _sampleRate = 16000;
  String? _language;
  final _eventController = StreamController<DictationTranscriptEvent>.broadcast();

  @override
  Stream<DictationTranscriptEvent> get transcriptEvents => _eventController.stream;

  @override
  Stream<String> get partialTranscripts =>
      transcriptEvents.map((event) => event.text);

  @override
  Future<void> start({
    required int sampleRate,
    List<String> glossary = const [],
    String? language,
  }) async {
    _sampleRate = sampleRate;
    _language = language;
  }

  @override
  void sendAudio(Uint8List pcm16Bytes) {
    _audioChunks.add(pcm16Bytes);
  }

  @override
  Future<DictationResult> finalize({
    String? prompt,
    String? systemPrompt,
  }) async {
    final wavBytes = _buildWav();
    final base64Audio = base64Encode(wavBytes);

    final output = await TranscribeAudioApi().call(
      TranscribeAudioInput(
        audioBase64: base64Audio,
        audioMimeType: 'audio/wav',
        prompt: prompt,
        language: _language,
      ),
    );

    return DictationResult(text: output.text, source: 'cloud-function');
  }

  Uint8List _buildWav() {
    var totalSamples = 0;
    for (final chunk in _audioChunks) {
      totalSamples += chunk.length ~/ 2;
    }

    final dataSize = totalSamples * 2;
    final fileSize = 44 + dataSize;
    final buffer = ByteData(fileSize);

    // RIFF header
    buffer.setUint8(0, 0x52); // R
    buffer.setUint8(1, 0x49); // I
    buffer.setUint8(2, 0x46); // F
    buffer.setUint8(3, 0x46); // F
    buffer.setUint32(4, fileSize - 8, Endian.little);
    buffer.setUint8(8, 0x57); // W
    buffer.setUint8(9, 0x41); // A
    buffer.setUint8(10, 0x56); // V
    buffer.setUint8(11, 0x45); // E

    // fmt sub-chunk
    buffer.setUint8(12, 0x66); // f
    buffer.setUint8(13, 0x6D); // m
    buffer.setUint8(14, 0x74); // t
    buffer.setUint8(15, 0x20); // (space)
    buffer.setUint32(16, 16, Endian.little); // sub-chunk size
    buffer.setUint16(20, 1, Endian.little); // PCM format
    buffer.setUint16(22, 1, Endian.little); // mono
    buffer.setUint32(24, _sampleRate, Endian.little);
    buffer.setUint32(28, _sampleRate * 2, Endian.little); // byte rate
    buffer.setUint16(32, 2, Endian.little); // block align
    buffer.setUint16(34, 16, Endian.little); // bits per sample

    // data sub-chunk
    buffer.setUint8(36, 0x64); // d
    buffer.setUint8(37, 0x61); // a
    buffer.setUint8(38, 0x74); // t
    buffer.setUint8(39, 0x61); // a
    buffer.setUint32(40, dataSize, Endian.little);

    // PCM16 samples
    var offset = 44;
    for (final chunk in _audioChunks) {
      for (var i = 0; i < chunk.length; i++) {
        buffer.setUint8(offset++, chunk[i]);
      }
    }

    return buffer.buffer.asUint8List();
  }

  @override
  void dispose() {
    _eventController.close();
    _audioChunks.clear();
  }
}

// ---------------------------------------------------------------------------
// BYOK batch session (OpenAI-compatible providers)
// ---------------------------------------------------------------------------

class ByokDictationSession implements DictationSession {
  ByokDictationSession({
    required this.apiKey,
    required this.provider,
    this.baseUrl,
    this.model,
    this.azureRegion,
  });

  final String apiKey;
  final ApiKeyProvider provider;
  final String? baseUrl;
  final String? model;
  final String? azureRegion;

  final _audioChunks = <Uint8List>[];
  int _sampleRate = 16000;
  String? _language;
  final _eventController = StreamController<DictationTranscriptEvent>.broadcast();

  @override
  Stream<DictationTranscriptEvent> get transcriptEvents => _eventController.stream;

  @override
  Stream<String> get partialTranscripts =>
      transcriptEvents.map((event) => event.text);

  String get _effectiveModel {
    if (model != null && model!.isNotEmpty) return model!;
    switch (provider) {
      case ApiKeyProvider.groq:
      case ApiKeyProvider.speaches:
        return 'whisper-large-v3';
      case ApiKeyProvider.gemini:
        return 'gemini-2.0-flash';
      default:
        return 'whisper-1';
    }
  }

  @override
  Future<void> start({
    required int sampleRate,
    List<String> glossary = const [],
    String? language,
  }) async {
    _sampleRate = sampleRate;
    _language = language;
  }

  @override
  void sendAudio(Uint8List pcm16Bytes) {
    _audioChunks.add(pcm16Bytes);
  }

  @override
  Future<DictationResult> finalize({
    String? prompt,
    String? systemPrompt,
  }) async {
    if (provider == ApiKeyProvider.gemini) {
      return _finalizeGemini(prompt: prompt);
    }
    if (provider == ApiKeyProvider.azure) {
      return _finalizeAzure(prompt: prompt);
    }
    return _finalizeWhisperCompatible(prompt: prompt);
  }

  Future<DictationResult> _finalizeWhisperCompatible({String? prompt}) async {
    final wavBytes = _buildWav();

    String apiUrl;
    switch (provider) {
      case ApiKeyProvider.groq:
        apiUrl = 'https://api.groq.com/openai/v1/audio/transcriptions';
        break;
      case ApiKeyProvider.speaches:
        final base = (baseUrl ?? '').replaceAll(RegExp(r'/+$'), '');
        apiUrl = '$base/v1/audio/transcriptions';
        break;
      case ApiKeyProvider.ollama:
        final base = (baseUrl ?? 'http://localhost:11434').replaceAll(RegExp(r'/+$'), '');
        apiUrl = '$base/v1/audio/transcriptions';
        break;
      case ApiKeyProvider.openaiCompatible:
        final base = (baseUrl ?? '').replaceAll(RegExp(r'/+$'), '');
        apiUrl = '$base/audio/transcriptions';
        break;
      default:
        apiUrl = 'https://api.openai.com/v1/audio/transcriptions';
        break;
    }

    final request = http.MultipartRequest('POST', Uri.parse(apiUrl))
      ..headers['Authorization'] = 'Bearer $apiKey'
      ..files.add(
        http.MultipartFile.fromBytes('file', wavBytes, filename: 'audio.wav'),
      )
      ..fields['model'] = _effectiveModel
      ..fields['response_format'] = 'text';

    if (prompt != null) request.fields['prompt'] = prompt;
    if (_language != null && _language != 'auto') request.fields['language'] = _language!;

    final response = await request.send();
    final body = await response.stream.bytesToString();

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw Exception('Transcription failed (${response.statusCode}): $body');
    }

    return DictationResult(text: body.trim(), source: provider.displayName);
  }

  Future<DictationResult> _finalizeGemini({String? prompt}) async {
    final wavBytes = _buildWav();
    final audioBase64 = base64Encode(wavBytes);
    final geminiModel = _effectiveModel;
    final url = Uri.parse(
      'https://generativelanguage.googleapis.com/v1beta/models/$geminiModel:generateContent?key=$apiKey',
    );

    final transcribePrompt = prompt != null && prompt.isNotEmpty
        ? 'Transcribe this audio exactly. Use these terms if you hear them: $prompt. Output only the transcription text.'
        : 'Transcribe this audio exactly. Output only the transcription text.';

    final body = jsonEncode({
      'contents': [
        {
          'parts': [
            {
              'inline_data': {
                'mime_type': 'audio/wav',
                'data': audioBase64,
              },
            },
            {'text': transcribePrompt},
          ],
        },
      ],
    });

    final response = await http.post(url, headers: {'Content-Type': 'application/json'}, body: body);

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw Exception('Gemini transcription failed (${response.statusCode}): ${response.body}');
    }

    final json = jsonDecode(response.body) as Map<String, dynamic>;
    final candidates = json['candidates'] as List?;
    final content = candidates?.firstOrNull as Map<String, dynamic>?;
    final parts = (content?['content'] as Map<String, dynamic>?)?['parts'] as List?;
    final text = (parts?.firstOrNull as Map<String, dynamic>?)?['text'] as String? ?? '';

    return DictationResult(text: text.trim(), source: 'Gemini');
  }

  Future<DictationResult> _finalizeAzure({String? prompt}) async {
    final wavBytes = _buildWav();
    final region = azureRegion ?? 'eastus';
    final lang = (_language == null || _language == 'auto') ? 'en-US' : _language!;
    final url = Uri.parse(
      'https://$region.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=$lang&format=detailed',
    );

    final response = await http.post(
      url,
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey,
        'Content-Type': 'audio/wav',
        'Accept': 'application/json',
      },
      body: wavBytes,
    );

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw Exception('Azure STT failed (${response.statusCode}): ${response.body}');
    }

    final json = jsonDecode(response.body) as Map<String, dynamic>;
    final text = json['DisplayText'] as String? ?? '';
    return DictationResult(text: text.trim(), source: 'Azure');
  }

  Uint8List _buildWav() {
    var totalSamples = 0;
    for (final chunk in _audioChunks) {
      totalSamples += chunk.length ~/ 2;
    }

    final dataSize = totalSamples * 2;
    final fileSize = 44 + dataSize;
    final buffer = ByteData(fileSize);

    buffer.setUint8(0, 0x52);
    buffer.setUint8(1, 0x49);
    buffer.setUint8(2, 0x46);
    buffer.setUint8(3, 0x46);
    buffer.setUint32(4, fileSize - 8, Endian.little);
    buffer.setUint8(8, 0x57);
    buffer.setUint8(9, 0x41);
    buffer.setUint8(10, 0x56);
    buffer.setUint8(11, 0x45);

    buffer.setUint8(12, 0x66);
    buffer.setUint8(13, 0x6D);
    buffer.setUint8(14, 0x74);
    buffer.setUint8(15, 0x20);
    buffer.setUint32(16, 16, Endian.little);
    buffer.setUint16(20, 1, Endian.little);
    buffer.setUint16(22, 1, Endian.little);
    buffer.setUint32(24, _sampleRate, Endian.little);
    buffer.setUint32(28, _sampleRate * 2, Endian.little);
    buffer.setUint16(32, 2, Endian.little);
    buffer.setUint16(34, 16, Endian.little);

    buffer.setUint8(36, 0x64);
    buffer.setUint8(37, 0x61);
    buffer.setUint8(38, 0x74);
    buffer.setUint8(39, 0x61);
    buffer.setUint32(40, dataSize, Endian.little);

    var offset = 44;
    for (final chunk in _audioChunks) {
      for (var i = 0; i < chunk.length; i++) {
        buffer.setUint8(offset++, chunk[i]);
      }
    }

    return buffer.buffer.asUint8List();
  }

  @override
  void dispose() {
    _eventController.close();
    _audioChunks.clear();
  }
}
