# Screen Capture Context Design

## Summary

Add a separate follow-up implementation PR that introduces optional screen-capture-based OCR context for dictation while preserving the current accuracy pipeline as the default fallback.

The design should support all platforms over time, but the first implementation can start where native support is strongest. If screen-capture permission is unavailable or denied, dictation must continue to work normally with the existing prompt/context pipeline.

## Chosen approach

### Recommended approach

Use a **single snapshot at finalize only** for the first implementation PR.

Why:

- lowest CPU/GPU and battery impact
- simplest permission and privacy model
- easiest way to keep fallback behavior safe
- cross-platform-capable architecture without requiring all platforms to implement capture immediately

### Alternatives considered

1. **Low-frequency snapshots during dictation plus finalize**
   - more temporal coverage
   - moderate processing overhead
   - more privacy and tuning complexity
2. **Continuous capture while dictating**
   - richest context
   - highest resource cost
   - largest privacy and implementation surface

These are intentionally deferred until the finalize-only path is proven valuable.

## Architecture

- Keep the existing accuracy pipeline as the base path.
- Add an optional **screen-capture context provider** that runs only when:
  - the platform supports capture,
  - the feature is enabled,
  - and the relevant permission is granted.
- For v1 on macOS, capture a single active-window snapshot at finalize, run OCR, and merge the resulting text into the existing shared `screenContext` field.
- If permission is missing, denied, or capture/OCR fails, fall back to the current accessibility-derived context and continue dictation normally.

## Data flow

At dictation finalize time:

1. collect the existing finalize-time context
2. invoke the new screen-capture provider
3. if OCR text is produced, merge it into the shared dictation context
4. build STT hints and post-process prompts from the same shared context contract

The shared contract remains unchanged so prompt construction and post-processing do not need a separate screen-capture-specific branch.

## Platform strategy

### macOS first implementation

- use ScreenCaptureKit to capture the active/frontmost window
- use Vision OCR on the captured image
- feed OCR text into the shared dictation context provider

### Cross-platform-capable design

- expose a platform-agnostic provider interface
- allow non-macOS platforms to return `null` until native capture support is added
- keep the shared prompt/context layer identical across desktop and mobile

### Mobile reuse

The same shared contract and prompt/context assembly should be reusable on mobile. Actual mobile screen capture can arrive later behind platform-specific implementations, but the dictation pipeline should already be prepared to consume that context.

## Permissions and fallback

- Screen-recording permission is an **enhancement** permission, not a hard requirement for dictation.
- It should be modeled separately from microphone and accessibility.
- Missing permission must not block recording, transcription, or post-processing.
- Errors such as no active window, failed capture, or empty OCR output should degrade to the current pipeline without user-visible failure.

## Verification

Testing should include:

- provider tests for permission granted / denied / unavailable
- finalize-time tests showing OCR context is attached when capture succeeds
- fallback tests proving dictation still works with no screen-capture context
- manual macOS validation that permission can be requested and then used without destabilizing local app behavior
