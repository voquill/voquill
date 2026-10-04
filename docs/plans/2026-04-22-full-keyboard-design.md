# Full Editable Mobile Keyboard With Voquill Action Bar

## Problem

Voquill's current mobile keyboards are voice-first shells, not full editable keyboards. Users need to be able to type and edit directly with familiar per-language key layouts while still accessing Voquill features such as transcription start/stop, mode switching, and language switching from the keyboard itself.

## Goals

- Ship a real editable keyboard on both Android and iOS
- Support familiar per-language layouts so users can type directly
- Add a slim Voquill action bar above the keys
- Keep the core keyboard structure conceptually consistent across platforms
- Preserve platform-native behavior for rendering, editing, and OS integration

## Non-Goals

- Pixel-identical keyboard chrome across Android and iOS
- A single shared renderer for both platforms
- Replacing required native controls such as the iOS globe/input-mode key

## Product Shape

The keyboard uses a three-layer structure:

1. **Suggestion row** (optional / phaseable) above the action bar
2. **Voquill action bar** with persistent actions for:
   - Start/Stop
   - Language
   - Mode
   - Overflow for lower-frequency actions
3. **Full key matrix** with familiar per-language layouts and normal editing keys

Language should also remain quickly accessible near the spacebar area. The keyboard must feel like a normal keyboard first; Voquill actions should augment editing rather than crowd it out.

## Cross-Platform Design Contract

Voquill should share a keyboard specification rather than a shared renderer.

### Shared

- Per-language layout definitions
- Semantic key roles
- Keyboard states:
  - alpha
  - shift
  - caps
  - 123
  - symbols
- Action-bar item definitions
- Mode and language metadata
- Shared sync contracts for Voquill settings, modes, tones, dictionary state, and transcription state

### Native Only

- Key rendering
- Touch handling
- Cursor and selection behavior
- Input APIs
- Toolbar chrome and safe-area behavior
- Audio and lifecycle behavior
- Platform-required controls and restrictions

## Platform Strategy

### Android

- Build a full IME key renderer and touch/layout engine
- Support per-language layouts through subtype/layout metadata
- Keep transcription and text commit native inside the IME
- Let the action bar control inline voice flows directly

### iOS

- Build a full keyboard extension key renderer
- Use the shared key spec, but adapt editing to `textDocumentProxy`
- Keep the action bar in the extension
- Allow voice flows to hand off to the host app when required by iOS constraints
- Preserve required globe/input-mode behavior and full-access gating

## Top Action Bar

The recommended top action bar is a separate slim row directly above the key matrix.

### Persistent actions

- **Start/Stop**
- **Language**
- **Mode**

### Overflow actions

- Tone/style variants
- Settings
- Help
- Account or status
- Lower-frequency Voquill tools

### UX rules

- Do not mix action buttons into suggestion chips
- Do not hide language only in overflow
- Do not shrink the spacebar excessively
- Keep editing ergonomics more important than feature density

## Keyboard Layout Model

The same keyboard across platforms should mean:

- the same per-language alpha matrices
- the same semantic key roles
- the same keyboard state transitions
- the same action model

It should **not** mean pixel-identical rendering across Android and iOS.

Start with familiar national layouts first, then expand. The layout engine should support:

- alpha layouts
- numeric layouts
- symbol layouts
- shift and caps transitions
- globe/language switching
- return/delete/space semantics

## Reuse From Current Voquill

Reusable areas:

- Voice/transcription/tone stack
- Shared mobile sync/contracts
- App-group and dictation plumbing
- Shared language/mode/tone state

Not reusable as-is:

- Current iOS keyboard UI shell
- Current Android IME voice-only shell
- Current hardcoded minimal key layout approach

## Main Risks

1. **iOS editing constraints**
   - `textDocumentProxy` makes selection and cursor handling weaker than Android.

2. **Renderer rebuild cost**
   - Both current mobile keyboard shells need substantial rebuilding for a real key matrix.

3. **Over-sharing implementation**
   - Sharing too much runtime logic across Android and iOS increases complexity and slows iteration.

4. **Toolbar crowding**
   - A feature-heavy bar can quickly damage editing ergonomics if too many actions are always visible.

## Recommended Approach

Use a **shared layout spec + native renderers**.

This gives Voquill:

- strong conceptual parity across Android and iOS
- familiar per-language typing behavior
- a consistent Voquill action bar model
- lower risk than trying to force one renderer or one full editing engine across both platforms

## Phased Rollout

1. **Phase 1**
   - One language family
   - Full editable key matrix
   - Slim action bar with Start/Stop, Language, Mode

2. **Phase 2**
   - More language layouts
   - Robust alpha/123/symbol/shift handling
   - Better overflow model

3. **Phase 3**
   - Suggestion/rewrite row
   - Deeper Voquill integrations
   - Stronger editing and cursor helpers

4. **Phase 4**
   - Polish, telemetry-informed tuning, and additional keyboard utilities

## Decision Summary

Voquill should evolve to a full editable multilingual keyboard on both Android and iOS. The core layout should be shared through a specification for layouts, states, and actions, while each platform keeps its own native renderer and editing behavior. A slim Voquill action bar above the keys should expose Start/Stop, Language, and Mode, with overflow for the rest.
