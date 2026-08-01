import 'package:app/actions/ai_settings_actions.dart';
import 'package:app/model/api_key_model.dart';
import 'package:app/utils/theme_utils.dart';
import 'package:app/widgets/settings/ai_configuration_sheet.dart';
import 'package:flutter/material.dart';

class AddApiKeyDialog extends StatefulWidget {
  final ApiKey? existingKey;
  final AiConfigContext configContext;

  const AddApiKeyDialog({
    super.key,
    this.existingKey,
    required this.configContext,
  });

  @override
  State<AddApiKeyDialog> createState() => _AddApiKeyDialogState();
}

class _AddApiKeyDialogState extends State<AddApiKeyDialog> {
  final _nameController = TextEditingController();
  final _keyController = TextEditingController();
  final _baseUrlController = TextEditingController();
  final _modelController = TextEditingController();
  final _azureRegionController = TextEditingController();
  ApiKeyProvider _provider = ApiKeyProvider.openai;
  bool _saving = false;
  bool _obscureKey = true;

  bool get _isEditing => widget.existingKey != null;

  List<ApiKeyProvider> get _availableProviders {
    return ApiKeyProvider.values.where((p) {
      return widget.configContext == AiConfigContext.transcription
          ? p.supportsTranscription
          : p.supportsPostProcessing;
    }).toList();
  }

  @override
  void initState() {
    super.initState();
    final existing = widget.existingKey;
    if (existing != null) {
      _nameController.text = existing.name;
      _provider = existing.provider;
      _baseUrlController.text = existing.baseUrl ?? '';
      _azureRegionController.text = existing.azureRegion ?? '';
      final model = widget.configContext == AiConfigContext.transcription
          ? existing.transcriptionModel
          : existing.postProcessingModel;
      _modelController.text = model ?? '';
    } else {
      final providers = _availableProviders;
      if (providers.isNotEmpty && !providers.contains(_provider)) {
        _provider = providers.first;
      }
    }
  }

  bool get _canSave {
    if (_nameController.text.trim().isEmpty) return false;
    if (!_isEditing && !_provider.isApiKeyOptional && _keyController.text.trim().isEmpty) {
      return false;
    }
    if (_provider.needsBaseUrl && _baseUrlController.text.trim().isEmpty) {
      return false;
    }
    if (_provider.needsAzureRegion && _azureRegionController.text.trim().isEmpty) {
      return false;
    }
    return true;
  }

  Future<void> _save() async {
    if (!_canSave) return;
    setState(() => _saving = true);

    try {
      final baseUrl = _provider.needsBaseUrl
          ? _baseUrlController.text.trim()
          : null;
      final azureRegion = _provider.needsAzureRegion
          ? _azureRegionController.text.trim()
          : null;
      final modelText = _modelController.text.trim();
      final transcriptionModel =
          widget.configContext == AiConfigContext.transcription && modelText.isNotEmpty
              ? modelText
              : widget.existingKey?.transcriptionModel;
      final postProcessingModel =
          widget.configContext == AiConfigContext.postProcessing && modelText.isNotEmpty
              ? modelText
              : widget.existingKey?.postProcessingModel;

      if (_isEditing) {
        final updated = await updateApiKey(
          id: widget.existingKey!.id,
          name: _nameController.text.trim(),
          provider: _provider,
          keyValue: _keyController.text.trim().isNotEmpty
              ? _keyController.text.trim()
              : null,
          baseUrl: baseUrl,
          transcriptionModel: transcriptionModel,
          postProcessingModel: postProcessingModel,
          azureRegion: azureRegion,
        );
        if (mounted) Navigator.pop(context, updated);
      } else {
        final keyValue = _keyController.text.trim();
        final apiKey = await createApiKey(
          name: _nameController.text.trim(),
          provider: _provider,
          keyValue: keyValue,
          baseUrl: baseUrl,
          transcriptionModel: transcriptionModel,
          postProcessingModel: postProcessingModel,
          azureRegion: azureRegion,
        );
        if (mounted) Navigator.pop(context, apiKey);
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to save API key: $e')),
        );
        setState(() => _saving = false);
      }
    }
  }

  @override
  void dispose() {
    _nameController.dispose();
    _keyController.dispose();
    _baseUrlController.dispose();
    _modelController.dispose();
    _azureRegionController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final showBaseUrl = _provider.needsBaseUrl;
    final showAzureRegion = _provider.needsAzureRegion;
    final showModel = widget.configContext == AiConfigContext.transcription
        ? _provider.supportsTranscription
        : _provider.supportsPostProcessing;

    return AlertDialog(
      insetPadding: Theming.padding.onlyHorizontal(),
      title: Text(_isEditing ? 'Edit API Key' : 'Add API Key'),
      content: SizedBox(
        width: double.maxFinite,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: _nameController,
                decoration: const InputDecoration(
                  labelText: 'Name',
                  hintText: 'e.g. My OpenAI Key',
                ),
                textCapitalization: TextCapitalization.words,
                onChanged: (_) => setState(() {}),
              ),
              if (!_isEditing) ...[
                const SizedBox(height: 16),
                DropdownButtonFormField<ApiKeyProvider>(
                  initialValue: _provider,
                  decoration: const InputDecoration(labelText: 'Provider'),
                  items: _availableProviders
                      .map((p) => DropdownMenuItem(
                            value: p,
                            child: Text(p.displayName),
                          ))
                      .toList(),
                  onChanged: (v) {
                    if (v != null) setState(() => _provider = v);
                  },
                ),
              ],
              if (_isEditing) ...[
                const SizedBox(height: 8),
                Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    'Provider: ${_provider.displayName}',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: Theme.of(context).colorScheme.onSurface.withAlpha(153),
                    ),
                  ),
                ),
              ],
              if (showBaseUrl) ...[
                const SizedBox(height: 16),
                TextField(
                  controller: _baseUrlController,
                  decoration: InputDecoration(
                    labelText: _provider == ApiKeyProvider.azure
                        ? 'Azure OpenAI Endpoint'
                        : 'Base URL',
                    hintText: _provider == ApiKeyProvider.speaches
                        ? 'http://localhost:8080'
                        : _provider == ApiKeyProvider.ollama
                            ? 'http://localhost:11434'
                            : _provider == ApiKeyProvider.azure
                                ? 'https://your-resource.openai.azure.com'
                                : 'https://your-server.com/v1',
                  ),
                  keyboardType: TextInputType.url,
                  onChanged: (_) => setState(() {}),
                ),
              ],
              if (showAzureRegion) ...[
                const SizedBox(height: 16),
                TextField(
                  controller: _azureRegionController,
                  decoration: const InputDecoration(
                    labelText: 'Azure Speech Region',
                    hintText: 'e.g. eastus',
                  ),
                  onChanged: (_) => setState(() {}),
                ),
              ],
              const SizedBox(height: 16),
              TextField(
                controller: _keyController,
                decoration: InputDecoration(
                  labelText: 'API Key',
                  hintText: _isEditing
                      ? 'Leave blank to keep current key'
                      : _provider.isApiKeyOptional
                          ? 'Optional'
                          : 'sk-...',
                  suffixIcon: IconButton(
                    icon: Icon(
                      _obscureKey ? Icons.visibility_off : Icons.visibility,
                    ),
                    onPressed: () => setState(() => _obscureKey = !_obscureKey),
                  ),
                ),
                obscureText: _obscureKey,
                onChanged: (_) => setState(() {}),
              ),
              if (showModel) ...[
                const SizedBox(height: 16),
                TextField(
                  controller: _modelController,
                  decoration: InputDecoration(
                    labelText: 'Model',
                    hintText: _getModelHint(),
                  ),
                  onChanged: (_) => setState(() {}),
                ),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _saving ? null : () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _saving || !_canSave ? null : _save,
          child: _saving
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Text('Save'),
        ),
      ],
    );
  }

  String _getModelHint() {
    final isTranscription = widget.configContext == AiConfigContext.transcription;
    switch (_provider) {
      case ApiKeyProvider.openai:
        return isTranscription ? 'e.g. whisper-1' : 'e.g. gpt-4o-mini';
      case ApiKeyProvider.groq:
        return isTranscription ? 'e.g. whisper-large-v3' : 'e.g. llama-3.3-70b-versatile';
      case ApiKeyProvider.deepseek:
        return 'e.g. deepseek-v4-flash';
      case ApiKeyProvider.openRouter:
        return 'e.g. openai/gpt-4o-mini';
      case ApiKeyProvider.openaiCompatible:
        return isTranscription ? 'e.g. whisper-1' : 'e.g. gpt-4o-mini';
      case ApiKeyProvider.speaches:
        return 'e.g. whisper-large-v3';
      case ApiKeyProvider.gemini:
        return 'e.g. gemini-2.0-flash';
      case ApiKeyProvider.claude:
        return 'e.g. claude-sonnet-4-20250514';
      case ApiKeyProvider.cerebras:
        return 'e.g. llama-3.3-70b';
      case ApiKeyProvider.ollama:
        return isTranscription ? 'e.g. whisper-1' : 'e.g. llama3';
      case ApiKeyProvider.azure:
        return isTranscription ? 'Region-based (optional)' : 'e.g. gpt-4o-mini';
    }
  }
}
