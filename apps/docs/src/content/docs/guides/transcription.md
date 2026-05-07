---
title: Transcription
description: Learn about Voquill's transcription modes and how to choose the right one.
---

Voquill supports three transcription modes. You can switch between them at any time from the settings page, or quickly from the **Transcription Provider** submenu in the system tray icon.

## Local

Local mode runs transcription entirely on your device using [Whisper](https://github.com/openai/whisper). Nothing leaves your machine.

- On first use, Voquill downloads a Whisper model (~142 MB for the default `base` model).
- Models are stored in your app data directory under `models/`.
- GPU acceleration is used automatically when available (Metal on macOS, Vulkan on Windows/Linux).
- You can force CPU-only inference by disabling GPU in settings.

Local mode is ideal when privacy is a priority or when you don't have a reliable internet connection.

## API

API mode sends your audio directly to Groq's Whisper API (`whisper-large-v3-turbo`) for transcription. This requires a Groq API key, which you can add in settings.

- Your API key is encrypted and stored locally.
- Transcription quality is generally higher than the local `base` model since it uses a larger model.
- Requires an internet connection.

## Cloud

Cloud mode routes audio through Voquill's cloud service, which handles the Groq API call on your behalf. This is the simplest option — no API key needed, just sign in with your Voquill account.

## Choosing a Mode

| Consideration       | Local        | API          | Cloud        |
| ------------------- | ------------ | ------------ | ------------ |
| Privacy             | Best         | Good         | Good         |
| Accuracy            | Good         | Best         | Best         |
| Internet required   | No           | Yes          | Yes          |
| API key required    | No           | Yes          | No           |
| Account required    | No           | No           | Yes          |
