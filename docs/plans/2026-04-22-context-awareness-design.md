# Context Awareness Design

## Summary
Bring VoiceInk-style context awareness into Voquill’s macOS dictation flow without turning this into a UI project. The design is Mac-first and extends the existing shared dictation architecture so app/editor context, selected text, and screen/OCR context can improve both AI post-processing and STT prompt hints when the chosen provider supports them.

## Goals
- Add real context awareness to macOS dictation.
- Use selected text, editor context, and screen/OCR context to improve accuracy.
- Feed rich context into AI post-processing and bounded context into STT prompt hints when supported.
- Preserve graceful degradation when permissions or platform signals are unavailable.
- Keep UI changes minimal and avoid making screen capture mandatory for dictation.

## Non-goals
- Full mobile or iOS parity in this phase.
- A new context settings UI.
- Making OCR/screen context a hard requirement for successful dictation.

## Recommended Approach
Implement a desktop-first context bundle:

1. Collect context at finalize time from existing desktop/native sources.
2. Normalize it into one shared `DictationContext`.
3. Feed full available context into AI post-processing.
4. Feed only bounded, provider-safe context into STT prompt hints when supported.

This matches the requested VoiceInk-style behavior without introducing continuous screen polling or a large backend redesign.

## Architecture
Extend the shared context model to carry:
- current app
- current editor
- selected text
- screen/OCR context
- glossary and replacement semantics

The desktop flow remains responsible for collecting platform signals. The shared dictation core remains responsible for context assembly and policy:
- what context can be included in post-processing
- what subset can be safely injected into STT prompts
- how to degrade when context is unavailable

## Data Flow
1. macOS dictation finalize gathers:
   - audio
   - `get_text_field_info`
   - current app target
   - `get_screen_context`
2. Desktop code derives selected text/editor metadata from accessibility info where possible.
3. Shared context assembly builds a normalized bundle with:
   - app/editor
   - selected text
   - screen/OCR text
   - dictionary and replacements
4. STT prompt generation uses the chosen provider’s prompt capability to decide whether bounded context can be included.
5. AI post-processing always receives the richest available context.
6. Dictation output continues through existing routing/insertion paths.

## Guardrails
- No large UI change in this phase.
- Context collection failure must never block dictation.
- Screen/OCR text must be truncated or summarized before prompt use.
- Raw screen text should not be persisted by default.
- If no permission or no available signal exists, the system should fall back cleanly to app/editor/glossary context or current behavior.

## Testing
- TDD for shared context assembly.
- Prompt-generation tests for:
  - post-processing context injection
  - provider-aware STT prompt inclusion
- Desktop integration tests proving finalize-time context reaches prompt generation.
- Regression tests proving dictation still works when no context is available.

## Scope
This phase implements macOS context awareness now and updates shared contracts only as needed to avoid drift with iOS/mobile. Full iOS context parity is intentionally deferred.
