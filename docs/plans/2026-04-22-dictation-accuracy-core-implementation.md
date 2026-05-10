# Dictation Accuracy Core Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve Voquill macOS dictation accuracy by introducing a shared dictation core for capability-aware planning, context assembly, authoritative transcript reconciliation, and unified cleanup, while defining contracts that iOS can reuse later.

**Architecture:** Create a new shared `@voquill/dictation-core` package and integrate it into desktop dictation orchestration first. Keep platform capture and output routing where they are, but move provider capability decisions, prompt/context construction, transcript ownership, and cleanup policy into shared code. Extend shared types now so mobile/iOS can adopt the same contracts later without re-inventing semantics.

**Tech Stack:** TypeScript, Vitest, pnpm workspace, Turborepo, Tauri desktop app, Flutter/iOS contract consumers, existing `@voquill/types` and `@voquill/voice-ai` packages

---

### Task 1: Create `@voquill/dictation-core` package and core contracts

**Files:**
- Create: `packages/dictation-core/package.json`
- Create: `packages/dictation-core/tsconfig.json`
- Create: `packages/dictation-core/vitest.config.ts`
- Create: `packages/dictation-core/src/index.ts`
- Create: `packages/dictation-core/src/capabilities.ts`
- Create: `packages/dictation-core/src/context.ts`
- Create: `packages/dictation-core/src/dictation-intent.ts`
- Create: `packages/dictation-core/src/reconciler.ts`
- Create: `packages/dictation-core/src/strategy.ts`
- Create: `packages/dictation-core/src/post-processing-policy.ts`
- Create: `packages/dictation-core/test/reconciler.test.ts`
- Create: `packages/dictation-core/test/capabilities.test.ts`
- Create: `packages/dictation-core/test/context.test.ts`
- Modify: `apps/desktop/package.json`
- Modify: `packages/types/src/transcription.types.ts`

**Step 1: Write the failing tests**

Create failing tests for:
- authoritative partial/final transcript reconciliation
- provider/model capability matching
- context assembly preserving glossary entries plus replacement destinations

```ts
test("reconciler replaces earlier streamed text with authoritative final text", () => {
  const reconciler = createTranscriptReconciler();

  reconciler.applyPartial({ text: "hello wor" });
  reconciler.applyFinal({ text: "hello world" });

  expect(reconciler.getAuthoritativeTranscript()).toBe("hello world");
});
```

```ts
test("capability selector rejects providers that cannot satisfy required prompt + streaming support", () => {
  const result = selectBestAccuracyPath({
    required: { streaming: true, prompt: true },
    candidates: [
      { provider: "azure", supportsStreaming: true, supportsPrompt: false },
      { provider: "deepgram", supportsStreaming: true, supportsPrompt: true },
    ],
  });

  expect(result.provider).toBe("deepgram");
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
cd /Users/chintan/Personal/repos/voquill/.worktrees/dictation-accuracy-core
npm exec --yes pnpm@10.11.0 -- --filter @voquill/dictation-core test
```

Expected: FAIL because the new package and implementation do not exist yet.

**Step 3: Write the minimal implementation**

Implement:
- package scaffolding with `build`, `test`, and `check-types` scripts
- provider capability types and selectors
- dictation intent/context types
- transcript reconciler that owns authoritative transcript state
- post-processing policy contract for lightweight cleanup vs LLM cleanup
- exports consumed by desktop integration

**Step 4: Run tests to verify they pass**

Run:

```bash
cd /Users/chintan/Personal/repos/voquill/.worktrees/dictation-accuracy-core
npm exec --yes pnpm@10.11.0 -- --filter @voquill/dictation-core test
npm exec --yes pnpm@10.11.0 -- --filter @voquill/dictation-core build
```

Expected: PASS for package tests and successful package build.

**Step 5: Commit checkpoint**

```bash
git add packages/dictation-core apps/desktop/package.json packages/types/src/transcription.types.ts
git commit -m "feat: add shared dictation accuracy core"
```

### Task 2: Move desktop prompt/context planning onto the shared core

**Files:**
- Modify: `apps/desktop/src/actions/transcribe.actions.ts`
- Modify: `apps/desktop/src/actions/transcriptions.actions.ts`
- Modify: `apps/desktop/src/utils/prompt.utils.ts`
- Modify: `apps/desktop/src/utils/string.utils.ts`
- Modify: `apps/desktop/src/utils/tone.utils.ts`
- Modify: `apps/desktop/src/actions/dictionary.actions.ts`
- Modify: `apps/desktop/src/repos/transcription.repo.ts`
- Modify: `apps/desktop/src/types/transcription-session.types.ts`
- Test: `apps/desktop/src/utils/prompt.utils.test.ts`
- Create: `apps/desktop/src/actions/transcribe.actions.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:
- replacement destinations are preserved in prompt/context assembly
- app/editor context is available to post-processing input
- BYOK provider/model capability checks choose the best path instead of blindly using the current provider

```ts
test("builds dictation context with glossary and replacement destinations", async () => {
  const result = buildDictationContext({
    terms: [
      { sourceValue: "voquill", destinationValue: "Voquill", isReplacement: true },
    ],
  });

  expect(result.glossaryTerms).toContain("voquill");
  expect(result.replacementMap.voquill).toBe("Voquill");
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
cd /Users/chintan/Personal/repos/voquill/.worktrees/dictation-accuracy-core
npm exec --yes pnpm@10.11.0 -- --filter desktop test -- src/utils/prompt.utils.test.ts src/actions/transcribe.actions.test.ts
```

Expected: FAIL because desktop code still uses the old glossary-only planning path.

**Step 3: Write the minimal implementation**

Integrate the shared core into desktop planning so:
- session planning becomes capability-aware
- dictation context carries glossary, replacements, tone intent, language, and available app/editor metadata
- post-processing input is produced by one shared context builder
- `accurateDictationEnabled` becomes a signal into the planner, not ad-hoc routing logic

**Step 4: Run tests to verify they pass**

Run:

```bash
cd /Users/chintan/Personal/repos/voquill/.worktrees/dictation-accuracy-core
npm exec --yes pnpm@10.11.0 -- --filter desktop test -- src/utils/prompt.utils.test.ts src/actions/transcribe.actions.test.ts
```

Expected: PASS for the new desktop planning tests.

**Step 5: Commit checkpoint**

```bash
git add apps/desktop/src/actions/transcribe.actions.ts apps/desktop/src/actions/transcriptions.actions.ts apps/desktop/src/utils/prompt.utils.ts apps/desktop/src/utils/string.utils.ts apps/desktop/src/utils/tone.utils.ts apps/desktop/src/actions/dictionary.actions.ts apps/desktop/src/repos/transcription.repo.ts apps/desktop/src/types/transcription-session.types.ts apps/desktop/src/utils/prompt.utils.test.ts apps/desktop/src/actions/transcribe.actions.test.ts
git commit -m "feat: route desktop dictation planning through shared core"
```

### Task 3: Replace append-only desktop transcript handling with authoritative reconciliation

**Files:**
- Modify: `apps/desktop/src/strategies/dictation.strategy.ts`
- Modify: `apps/desktop/src/sessions/index.ts`
- Modify: `apps/desktop/src/sessions/new-server-transcription-session.ts`
- Modify: `apps/desktop/src/sessions/local-transcription-session.ts`
- Modify: `apps/desktop/src/sessions/batch-transcription-session.ts`
- Modify: `apps/desktop/src/repos/transcribe-audio.repo.ts`
- Modify: `apps/desktop/src/utils/transcribe.utils.ts`
- Modify: `apps/desktop/src/components/root/DictationSideEffects.tsx`
- Test: `apps/desktop/src/sessions/new-server-transcription-session.test.ts`
- Test: `apps/desktop/src/repos/transcribe-audio.repo.test.ts`
- Create: `apps/desktop/test/integration/post-processing-stability.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:
- final transcript replaces prior streamed segments instead of appending duplicate text
- segment merge logic prefers authoritative final output over fuzzy overlap guesses
- timeout/fallback preserves best-known transcript state cleanly

```ts
test("final streamed transcript replaces earlier interim text", async () => {
  const strategy = createDictationStrategyForTest();

  strategy.handleInterimSegment("hello wor");
  const result = await strategy.handleTranscript({
    rawTranscript: "hello world",
    processedTranscript: "hello world",
    toneId: null,
    a11yInfo: null,
    currentApp: null,
    loadingToken: null,
    audio: null as never,
    transcriptionMetadata: {},
    transcriptionWarnings: [],
  });

  expect(result.transcript).toBe("hello world");
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
cd /Users/chintan/Personal/repos/voquill/.worktrees/dictation-accuracy-core
npm exec --yes pnpm@10.11.0 -- --filter desktop test -- src/sessions/new-server-transcription-session.test.ts src/repos/transcribe-audio.repo.test.ts test/integration/post-processing-stability.test.ts
```

Expected: FAIL because current desktop dictation still relies on append-only streamed output and fuzzy merge behavior.

**Step 3: Write the minimal implementation**

Integrate the shared reconciler into desktop sessions and strategy code so:
- partial/final transcript events feed one authoritative transcript state
- server-processed final text can override local append-only state safely
- long-audio batch merge logic becomes deterministic and reconciliation-aware
- output routing receives one final stabilized transcript

**Step 4: Run tests to verify they pass**

Run:

```bash
cd /Users/chintan/Personal/repos/voquill/.worktrees/dictation-accuracy-core
npm exec --yes pnpm@10.11.0 -- --filter desktop test -- src/sessions/new-server-transcription-session.test.ts src/repos/transcribe-audio.repo.test.ts test/integration/post-processing-stability.test.ts
```

Expected: PASS for session, repo, and integration stability tests.

**Step 5: Commit checkpoint**

```bash
git add apps/desktop/src/strategies/dictation.strategy.ts apps/desktop/src/sessions/index.ts apps/desktop/src/sessions/new-server-transcription-session.ts apps/desktop/src/sessions/local-transcription-session.ts apps/desktop/src/sessions/batch-transcription-session.ts apps/desktop/src/repos/transcribe-audio.repo.ts apps/desktop/src/utils/transcribe.utils.ts apps/desktop/src/components/root/DictationSideEffects.tsx apps/desktop/src/sessions/new-server-transcription-session.test.ts apps/desktop/src/repos/transcribe-audio.repo.test.ts apps/desktop/test/integration/post-processing-stability.test.ts
git commit -m "feat: reconcile desktop dictation transcripts authoritatively"
```

### Task 4: Define iOS-ready shared contracts and preserve replacement semantics end-to-end

**Files:**
- Modify: `packages/types/src/transcription.types.ts`
- Modify: `mobile/lib/api/dictation_api.dart`
- Modify: `mobile/lib/model/transcription_model.dart`
- Modify: `mobile/lib/utils/channel_utils.dart`
- Modify: `mobile/lib/actions/keyboard_actions.dart`
- Modify: `mobile/lib/model/tone_model.dart`
- Modify: `mobile/ios/Runner/AppDelegate.swift`
- Modify: `mobile/ios/keyboard/Types/SharedTerm.swift`
- Modify: `mobile/ios/keyboard/Utils/PromptUtils.swift`
- Create: `apps/desktop/src/utils/transcription-contracts.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:
- shared transcript event contracts preserve replacement destinations and dictation intent
- mobile sync payloads keep both source and destination values for replacements
- desktop and mobile contract shapes stay aligned

```ts
test("shared term payload preserves replacement destination", () => {
  const payload = toSharedTermPayload({
    sourceValue: "voquill",
    destinationValue: "Voquill",
    isReplacement: true,
  });

  expect(payload.destinationValue).toBe("Voquill");
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
cd /Users/chintan/Personal/repos/voquill/.worktrees/dictation-accuracy-core
npm exec --yes pnpm@10.11.0 -- --filter desktop test -- src/utils/transcription-contracts.test.ts
```

Expected: FAIL because the current shared/mobile contract path drops replacement destinations and richer dictation metadata.

**Step 3: Write the minimal implementation**

Implement shared contract updates so:
- replacement destinations survive app-to-keyboard and future iOS reuse paths
- transcript event metadata can carry authoritative/finalized state
- mobile remains behavior-light in this phase but ready to consume the same semantics later

**Step 4: Run tests to verify they pass**

Run:

```bash
cd /Users/chintan/Personal/repos/voquill/.worktrees/dictation-accuracy-core
npm exec --yes pnpm@10.11.0 -- --filter desktop test -- src/utils/transcription-contracts.test.ts
```

Expected: PASS for shared contract coverage.

**Step 5: Commit checkpoint**

```bash
git add packages/types/src/transcription.types.ts mobile/lib/api/dictation_api.dart mobile/lib/model/transcription_model.dart mobile/lib/utils/channel_utils.dart mobile/lib/actions/keyboard_actions.dart mobile/lib/model/tone_model.dart mobile/ios/Runner/AppDelegate.swift mobile/ios/keyboard/Types/SharedTerm.swift mobile/ios/keyboard/Utils/PromptUtils.swift apps/desktop/src/utils/transcription-contracts.test.ts
git commit -m "feat: align shared dictation contracts for ios reuse"
```

### Task 5: Run focused verification for the affected surfaces

**Files:**
- Modify as needed based on failing tests only

**Step 1: Run package and desktop focused verification**

Run:

```bash
cd /Users/chintan/Personal/repos/voquill/.worktrees/dictation-accuracy-core
npm exec --yes pnpm@10.11.0 -- --filter @voquill/dictation-core test
npm exec --yes pnpm@10.11.0 -- --filter @voquill/dictation-core build
npm exec --yes pnpm@10.11.0 -- --filter desktop test -- src/actions/transcribe.actions.test.ts src/utils/prompt.utils.test.ts src/utils/transcription-contracts.test.ts src/sessions/new-server-transcription-session.test.ts src/repos/transcribe-audio.repo.test.ts test/integration/post-processing-stability.test.ts
npm exec --yes pnpm@10.11.0 -- --filter desktop build
```

Expected: PASS for the new shared-core and desktop-focused verification commands.

**Step 2: Run repo-level checks only for touched packages when practical**

Run:

```bash
cd /Users/chintan/Personal/repos/voquill/.worktrees/dictation-accuracy-core
npm exec --yes pnpm@10.11.0 -- --filter @voquill/dictation-core check-types
npm exec --yes pnpm@10.11.0 -- --filter @voquill/types build
```

Expected: PASS for touched shared packages.

**Step 3: Document known baseline blockers**

Record without “fixing” them unless this work touches them:
- root `lint` baseline failure in `enterprise/admin`
- root `check-types` baseline issues in `enterprise/gateway` and `apps/docs`
- root `test` dependency on local Postgres for `enterprise/gateway`

**Step 4: Commit checkpoint**

```bash
git add .
git commit -m "feat: improve dictation accuracy core and desktop pipeline"
```
