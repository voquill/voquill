---
title: Transcription
description: Learn about Voquill's transcription modes and how to choose the right one.
---

Voquill supports three transcription modes. You can switch between them at any time from the settings page.

## Local

Local mode runs transcription entirely on your device using [Whisper](https://github.com/openai/whisper). Nothing leaves your machine.

- On first use, Voquill downloads a Whisper model (~142 MB for the default `base` model).
- Models are stored in your app data directory under `models/`.
- GPU acceleration is used automatically when available (Metal on macOS, Vulkan on Windows/Linux).
- You can force CPU-only inference by disabling GPU in settings.

Local mode is ideal when privacy is a priority or when you don't have a reliable internet connection.

## API

API mode sends audio directly to your selected transcription provider. Add the provider's API key in settings, then select it for transcription.

- Your API key is encrypted and stored locally.
- Transcription quality is generally higher than the local `base` model since it uses a larger model.
- Requires an internet connection.

### 60db

[60db](https://docs.60db.ai) provides a workspace-authenticated transcription API.
In desktop settings, choose API mode, add a key with provider **60db**, and select
that key. The existing encrypted local key storage is used.

Audio is uploaded as WAV after recording stops. Longer recordings use the existing
60-second segments and overlap merging, with one request at a time. Language can
be specified or detected automatically. No model selection is required because
the service selects its model. Each request has a 60-second timeout and is not
retried automatically; successful empty transcripts are accepted.

The key test checks authentication through the voice catalog without uploading
audio. It does not verify transcription credits or recording quality. Audio is
sent to 60db when this provider is selected; use local mode to keep audio on device.

## Cloud

Cloud mode routes audio through Voquill's cloud service, which handles the Groq API call on your behalf. This is the simplest option — no API key needed, just sign in with your Voquill account.

## Choosing a Mode

| Consideration     | Local | API  | Cloud |
| ----------------- | ----- | ---- | ----- |
| Privacy           | Best  | Good | Good  |
| Accuracy          | Good  | Best | Best  |
| Internet required | No    | Yes  | Yes   |
| API key required  | No    | Yes  | No    |
| Account required  | No    | No   | Yes   |
