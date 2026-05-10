# Dictation Accuracy Pipeline

This document summarizes the accuracy, context, and local-install improvements on the `feat/dictation-accuracy-core` branch.

## What landed

### Shared dictation core

- Introduced `@voquill/dictation-core` to centralize dictation context assembly.
- Normalizes glossary terms, replacement rules, active-app metadata, editor metadata, selected text, and screen-context strings before prompt construction.
- Keeps desktop and mobile prompt-building behavior aligned instead of duplicating slightly different logic per client.

### Transcript contract and persistence

- Desktop persistence now stores a stronger transcription contract with:
  - raw transcript
  - authoritative transcript
  - sanitized/final transcript
  - prompt metadata used during transcription and post-processing
- This makes post-processing more deterministic and gives each stage a clearer source of truth.

### Context-aware prompting

- Desktop dictation finalization now threads in:
  - current app
  - current editor
  - selected text
  - screen context gathered from the accessibility tree around the focused element
- These signals are used both for STT prompt hints where supported and for AI post-processing.
- The main benefit is better handling of names, product terms, casing, and references to visible work.

### Streaming and finalize reliability

- Restored safe live streaming insertion during dictation.
- Fixed the failure path where interim insertion problems could otherwise lose text at finalize time.
- Final transcript persistence and insertion behavior are now aligned around the same canonical text contract.

### macOS permission and local-install stabilization

- Accessibility permission checks no longer collapse passive "not yet granted" states into hard denial.
- Startup/onboarding permission requests are tracked so the app does not keep retriggering the same request path.
- Added a local macOS installer helper that only replaces `/Applications/Voquill (local).app`.
- Local Tauri builds disable updater artifacts so local test builds do not fail on missing signing keys.

## Why this improves accuracy

The branch improves accuracy as a system rather than only changing the speech-to-text model:

- prompts carry more useful context
- cleanup runs against a cleaner transcript contract
- live and final transcript handling are less error-prone
- glossary and replacement rules are applied consistently
- desktop and mobile share the same context/prompting model where possible

In practice this is most helpful for:

- proper nouns
- product and project names
- code symbols and formatting-sensitive phrases
- selected-text rewrites
- app-specific dictation where the current window meaning matters

## Mobile reuse

The same approach is intended to be reusable on mobile as well.

Already aligned in this branch:

- shared dictation context schema in `packages/types`
- shared dictation-core assembly logic
- mobile prompt construction updates in the iOS keyboard and Flutter layers
- transcript/tone/shared-term model alignment

That means mobile can use the same categories of improvement for:

- glossary and replacement rules
- selected text or editor-aware prompt shaping
- transcript contract consistency
- post-processing behavior that matches desktop expectations

## Current limit on macOS context

The current desktop `screenContext` implementation is **not** full screen capture.

Today it is derived from the accessibility tree near the focused element. That is useful, but it is narrower than a true screen-recording + OCR pipeline.

## Follow-up: screen-capture-based context

A separate follow-up PR should add real screen-capture context for macOS:

- request screen-recording permission explicitly
- capture the active window with ScreenCaptureKit
- run OCR over the captured image
- feed that text into the same shared dictation context pipeline

That follow-up should remain separate because it changes permissions, native capture behavior, and privacy expectations in a more substantial way than the work in this branch.
