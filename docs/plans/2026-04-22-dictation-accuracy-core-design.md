# Dictation Accuracy Core Design

## Summary
Build a shared dictation accuracy core with a Mac-first integration. The first shipped implementation is macOS, but the core contracts and orchestration logic are shared so iOS can reuse them later without redesigning the system.

The system should pursue the highest-accuracy path available for each session, even when that means a cloud-first or hybrid flow. Bring-your-own-key (BYOK) provider credentials and explicit model choice are hard requirements. UI changes stay minimal; the work is primarily internal.

## Goals
- Improve dictation accuracy materially on Mac now.
- Centralize accuracy decisions and transcript ownership in shared code.
- Support provider-specific capabilities, BYOK credentials, and model selection.
- Preserve current output routing and keep platform capture local.
- Make iOS reuse straightforward through shared contracts.

## Non-goals
- Full iOS feature parity in this phase.
- A broad settings/UI redesign.
- Replacing the current output routing model.

## Architecture
The shared accuracy core is composed of five parts:

1. **Provider capability registry** — declares each provider/model's transcription, prompting, vocabulary, context, streaming, cleanup, and fallback capabilities.
2. **Context assembler** — builds the best available session context from app/editor metadata, dictation intent, replacements, and platform-provided signals.
3. **Transcript reconciler** — owns the authoritative transcript for the session, merges partial/final outputs, and performs stronger long-audio reconciliation.
4. **Post-processing policy** — applies a unified cleanup pipeline and consistent replacement semantics after reconciliation.
5. **Accuracy strategy selector** — chooses the highest-accuracy viable path for the session, including cloud-first, hybrid, and next-best fallback behavior within capability constraints.

Mac integrates first by keeping capture and app-context collection in platform code, then delegating planning, reconciliation, and cleanup to the shared core.

## Data Flow
1. **Local capture**: macOS capture stays local and continues to gather audio plus available app/editor context.
2. **Session planning**: the shared orchestrator uses the capability registry, BYOK/provider configuration, model selection, and live context to plan the session.
3. **Transcription execution**: the selected provider path runs, with provider-aware prompting and vocabulary injection when supported.
4. **Authoritative reconciliation**: the transcript reconciler merges chunk/segment results, retries or falls back when needed, and remains the single source of truth for transcript state.
5. **Unified cleanup**: the post-processing policy applies shared cleanup, dictation-intent-aware formatting, and replacement rules.
6. **Output delivery**: the existing output routing remains in place; the improved transcript is handed off through current insertion/output paths.

## Accuracy Improvements
- Provider-aware prompting and vocabulary handling instead of one generic prompt path.
- Stronger reconciliation for long audio, including chunk/segment merge rules and authoritative finalization.
- Automatic next-best fallback when the preferred path fails or a capability is unavailable.
- Real Mac context injection from the active app/editor when available.
- Unified replacement semantics so replacements behave the same across paths.
- A shared dictation intent model used by planning, prompting, and cleanup.
- A consistent cleanup/post-processing policy across providers and platforms.

## Defaults and Decision Rules
- Default to the highest-accuracy capable path for the session.
- BYOK provider choice and user-selected model win whenever that combination satisfies required capabilities.
- If the preferred provider/model cannot satisfy the plan or fails mid-session, automatically fall back to the next-best supported path.
- Always use available app/editor context when the platform can provide it.
- Scope this phase to Mac-first delivery, while keeping contracts reusable for iOS and other supported platforms later.

## Reuse Across Platforms
Shared reuse happens through stable contracts for capability discovery, session planning, transcript reconciliation, dictation intent, and cleanup. iOS should adopt those contracts when it is ready, but this work does not attempt full behavioral parity or platform rollout now.
