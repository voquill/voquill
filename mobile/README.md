# Voquill Mobile

The mobile workspace contains the Flutter app and iOS keyboard integration for Voquill.

## Accuracy pipeline reuse

This repo now shares more of the dictation pipeline between desktop and mobile:

- shared dictation context types in `packages/types`
- shared prompt/context assembly in `packages/dictation-core`
- aligned shared-term, tone, and transcription models
- mobile prompt updates in the Flutter and iOS keyboard codepaths

That means the same improvement strategy used for desktop can be utilized on mobile as well:

- preserve raw vs. finalized transcript intent more consistently
- pass glossary and replacement rules through the same contract
- shape prompts with richer user and editing context
- keep post-processing behavior aligned across clients

## Current limitation

The desktop branch includes accessibility-derived screen context, but it does **not** yet include true screen-capture OCR context. Any future screen-capture-based context should be added as a separate platform-specific follow-up, then fed into the same shared dictation context contract used by mobile and desktop.

## Getting started

```bash
flutter pub get
flutter run
```
