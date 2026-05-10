# Context Awareness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add VoiceInk-style context awareness to Voquill macOS dictation by wiring selected-text/editor context and screen/OCR context into shared dictation context, STT prompt hints when supported, and AI post-processing.

**Architecture:** Reuse the existing `@voquill/dictation-core` and desktop dictation pipeline rather than introducing a new subsystem. Extend shared context contracts, collect native context at finalize time, inject bounded context into STT prompt generation for capable providers, and inject full available context into AI post-processing while preserving graceful degradation.

**Tech Stack:** TypeScript, Rust/Tauri, Vitest, pnpm workspace, existing desktop native bindings, shared `@voquill/dictation-core`, existing macOS accessibility/screen-context commands

---

### Task 1: Extend shared dictation context for selected text and screen context

**Files:**
- Modify: `packages/types/src/transcription.types.ts`
- Modify: `packages/dictation-core/src/context.ts`
- Modify: `packages/dictation-core/test/context.test.ts`
- Modify: `apps/desktop/src/utils/prompt.utils.ts`
- Modify: `apps/desktop/src/utils/prompt.utils.test.ts`

**Step 1: Write the failing test**

Add failing tests proving:
- `DictationContext` can carry selected text and screen context
- context assembly sanitizes and preserves those values
- post-processing prompts include those fields when present

**Step 2: Run test to verify it fails**

Run:

```bash
cd /Users/chintan/Personal/repos/voquill/.worktrees/dictation-accuracy-core
npm exec --yes pnpm@10.11.0 -- --filter @voquill/dictation-core test
npm exec --yes pnpm@10.11.0 -- --dir apps/desktop exec vitest run src/utils/prompt.utils.test.ts
```

Expected: FAIL because selected text and screen context are not yet part of the shared context/prompt path.

**Step 3: Write minimal implementation**

Extend the shared context types and assembly so selected text and screen context become first-class optional fields. Update prompt generation to include them in post-processing context.

**Step 4: Run test to verify it passes**

Run the same commands and confirm PASS.

**Step 5: Commit**

```bash
git add packages/types/src/transcription.types.ts packages/dictation-core/src/context.ts packages/dictation-core/test/context.test.ts apps/desktop/src/utils/prompt.utils.ts apps/desktop/src/utils/prompt.utils.test.ts
git commit -m "feat: extend shared dictation context for screen and selection"
```

### Task 2: Wire desktop finalize flow to collect and pass editor and screen context

**Files:**
- Modify: `apps/desktop/src/components/root/DictationSideEffects.tsx`
- Modify: `apps/desktop/src/strategies/dictation.strategy.ts`
- Modify: `apps/desktop/src/types/transcription-session.types.ts`
- Modify: `apps/desktop/src/actions/transcribe.actions.ts`
- Create: `apps/desktop/src/actions/transcribe.context.test.ts`

**Step 1: Write the failing test**

Add a failing test proving finalize-time context collection passes:
- current app
- current editor/selected text when available from `a11yInfo`
- screen context from `get_screen_context`

into the post-processing path.

**Step 2: Run test to verify it fails**

Run:

```bash
cd /Users/chintan/Personal/repos/voquill/.worktrees/dictation-accuracy-core/apps/desktop
npm exec --yes pnpm@10.11.0 -- exec vitest run src/actions/transcribe.context.test.ts
```

Expected: FAIL because the desktop finalize flow currently leaves `currentEditor` null and does not wire screen context into dictation prompts.

**Step 3: Write minimal implementation**

Collect `get_screen_context`, derive editor/selected text from accessibility info where possible, and thread that context into the existing desktop finalize and post-processing path.

**Step 4: Run test to verify it passes**

Run the same test command and confirm PASS.

**Step 5: Commit**

```bash
git add apps/desktop/src/components/root/DictationSideEffects.tsx apps/desktop/src/strategies/dictation.strategy.ts apps/desktop/src/types/transcription-session.types.ts apps/desktop/src/actions/transcribe.actions.ts apps/desktop/src/actions/transcribe.context.test.ts
git commit -m "feat: wire desktop editor and screen context into dictation"
```

### Task 3: Add provider-aware STT prompt context injection

**Files:**
- Modify: `apps/desktop/src/actions/transcribe.actions.ts`
- Modify: `apps/desktop/src/repos/transcribe-audio.repo.ts`
- Modify: `apps/desktop/src/repos/transcribe-audio.repo.test.ts`
- Modify: `packages/voice-ai/src/xai.utils.ts` (only if prompt shape needs extension)

**Step 1: Write the failing test**

Add failing tests proving that:
- providers that support prompt hints receive bounded screen/editor context
- providers without prompt support do not receive unsupported payloads
- fallback and xAI paths preserve the prompt-enhanced context

**Step 2: Run test to verify it fails**

Run:

```bash
cd /Users/chintan/Personal/repos/voquill/.worktrees/dictation-accuracy-core/apps/desktop
npm exec --yes pnpm@10.11.0 -- exec vitest run src/repos/transcribe-audio.repo.test.ts src/actions/transcribe.actions.test.ts
```

Expected: FAIL because current STT prompt generation is still primarily glossary-based and not screen/editor-context-aware.

**Step 3: Write minimal implementation**

Generate bounded context-aware STT hints from the shared context model and pass them only through provider/model paths that support prompt input.

**Step 4: Run test to verify it passes**

Run the same focused tests and confirm PASS.

**Step 5: Commit**

```bash
git add apps/desktop/src/actions/transcribe.actions.ts apps/desktop/src/repos/transcribe-audio.repo.ts apps/desktop/src/repos/transcribe-audio.repo.test.ts packages/voice-ai/src/xai.utils.ts
git commit -m "feat: inject provider-aware context into stt prompts"
```

### Task 4: Run focused verification for context-aware dictation

**Files:**
- Modify only if failing verification requires a small fix

**Step 1: Run focused verification**

Run:

```bash
cd /Users/chintan/Personal/repos/voquill/.worktrees/dictation-accuracy-core
npm exec --yes pnpm@10.11.0 -- --filter @voquill/types build
npm exec --yes pnpm@10.11.0 -- --filter @voquill/dictation-core check-types
npm exec --yes pnpm@10.11.0 -- --filter @voquill/dictation-core test
npm exec --yes pnpm@10.11.0 -- --filter @voquill/dictation-core build
npm exec --yes pnpm@10.11.0 -- --dir apps/desktop exec vitest run src/utils/prompt.utils.test.ts src/actions/transcribe.actions.test.ts src/actions/transcribe.context.test.ts src/repos/transcribe-audio.repo.test.ts src/sessions/new-server-transcription-session.test.ts src/repos/transcription.repo.test.ts test/integration/post-processing-stability.test.ts
npm exec --yes pnpm@10.11.0 -- --filter desktop build
```

Expected: PASS for the touched shared and desktop surfaces.

**Step 2: Run native/mobile-adjacent checks when practical**

Run:

```bash
cd /Users/chintan/Personal/repos/voquill/.worktrees/dictation-accuracy-core/mobile
dart analyze lib/api/dictation_api.dart
```

Expected: exit 0. Info-level lints are acceptable if there are no errors.

**Step 3: Commit**

```bash
git add .
git commit -m "feat: add context-aware dictation prompts and post-processing"
```
