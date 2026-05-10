# Screen Capture Context Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add optional screen-capture OCR context to the dictation finalize path, starting with macOS, while falling back cleanly to the existing accuracy pipeline when screen-recording permission is unavailable.

**Architecture:** Keep the current accessibility-based context flow as the default path, then layer in a separate finalize-only screen-capture provider that can return OCR text when the platform supports it and permission is granted. Reuse the existing shared `screenContext` contract so prompt construction, post-processing, and mobile reuse continue to flow through one context model instead of adding a second prompt pipeline.

**Tech Stack:** Tauri 2, Rust, TypeScript/React, Zustand, Vitest, ScreenCaptureKit, Vision OCR, macOS permission APIs

---

### Task 1: Create the isolated implementation worktree

**Files:**
- Create: _none_
- Modify: _none_
- Test: _none_

**Step 1: Create the worktree**

```bash
cd /Users/chintan/Personal/repos/voquill
git fetch upstream
git worktree add .worktrees/screen-capture-context -b feat/screen-capture-context upstream/main
```

**Step 2: Verify the worktree is on the new branch**

Run:

```bash
cd /Users/chintan/Personal/repos/voquill/.worktrees/screen-capture-context
git branch --show-current
```

Expected: `feat/screen-capture-context`

**Step 3: Cherry-pick the approved design doc commit**

```bash
git cherry-pick d1290816
```

**Step 4: Verify the design doc is present**

Run:

```bash
test -f docs/plans/2026-04-22-screen-capture-context-design.md
```

Expected: exit code `0`

**Step 5: Commit state checkpoint if cherry-pick required conflict resolution**

```bash
git status --short
```

Expected: clean working tree

### Task 2: Add an optional screen-recording permission contract

**Files:**
- Modify: `apps/desktop/src/types/permission.types.ts`
- Modify: `apps/desktop/src/state/app.state.ts`
- Modify: `apps/desktop/src/utils/permission.utils.ts`
- Modify: `apps/desktop/src/components/dashboard/PermissionsDialog.tsx`
- Test: `apps/desktop/src/utils/permission-flow.utils.test.ts`

**Step 1: Write the failing test**

Add a Vitest case proving the new permission kind can be represented without becoming a startup blocker:

```ts
it("treats screen recording as an optional enhancement permission", async () => {
  const { derivePermissionGateState } = await loadSubject();

  expect(
    derivePermissionGateState?.({
      kind: "screen-recording",
      status: {
        kind: "screen-recording",
        state: "not-determined",
        promptShown: false,
      },
      requestInFlight: false,
      awaitingExternalApproval: false,
    }),
  ).toMatchObject({
    canRequest: true,
  });
});
```

**Step 2: Run the test to verify it fails**

Run:

```bash
cd apps/desktop
npm exec --yes pnpm@10.11.0 -- vitest run src/utils/permission-flow.utils.test.ts
```

Expected: FAIL because `"screen-recording"` is not part of the permission contract yet

**Step 3: Write the minimal implementation**

- Extend `PermissionKind` with `"screen-recording"`.
- Expand the permission state store so it can track lifecycle for the new optional permission.
- Add `checkScreenRecordingPermission`, `requestScreenRecordingPermission`, label text, and macOS instructions in `permission.utils.ts`.
- Update `PermissionsDialog.tsx` to render a non-required enhancement row for screen recording without adding it to `REQUIRED_PERMISSIONS`.

**Step 4: Run the test to verify it passes**

Run:

```bash
cd apps/desktop
npm exec --yes pnpm@10.11.0 -- vitest run src/utils/permission-flow.utils.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add apps/desktop/src/types/permission.types.ts \
        apps/desktop/src/state/app.state.ts \
        apps/desktop/src/utils/permission.utils.ts \
        apps/desktop/src/components/dashboard/PermissionsDialog.tsx \
        apps/desktop/src/utils/permission-flow.utils.test.ts
git commit -m "feat: add screen recording permission contract"
```

### Task 3: Add macOS screen-recording permission commands

**Files:**
- Modify: `apps/desktop/src-tauri/src/platform/macos/permissions.rs`
- Modify: `apps/desktop/src-tauri/src/commands.rs`
- Modify: `apps/desktop/src-tauri/src/app.rs`
- Modify: `packages/desktop-native-apis/src/bindings.ts`
- Test: `apps/desktop/src/utils/permission-flow.utils.test.ts`

**Step 1: Write the failing TypeScript wrapper usage**

In `permission.utils.ts`, add wrappers that expect native commands to exist:

```ts
export const checkScreenRecordingPermission = async (): Promise<PermissionStatus> => {
  return invoke<PermissionStatus>("check_screen_recording_permission");
};

export const requestScreenRecordingPermission = async (): Promise<PermissionStatus> => {
  return invoke<PermissionStatus>("request_screen_recording_permission");
};
```

**Step 2: Run a targeted type/build check to verify it fails**

Run:

```bash
cd apps/desktop
npm exec --yes pnpm@10.11.0 -- build
```

Expected: FAIL because the Rust command layer does not expose those commands yet

**Step 3: Write the minimal implementation**

- In `permissions.rs`, add screen-recording check/request helpers using `CGPreflightScreenCaptureAccess()` and `CGRequestScreenCaptureAccess()`.
- Return the same `PermissionStatus` shape already used for microphone/accessibility.
- Register the commands in `commands.rs` and include them in the Tauri handler list in `app.rs`.
- Regenerate or update `packages/desktop-native-apis/src/bindings.ts` if command bindings are consumed from the generated API package.

**Step 4: Run the build to verify it passes**

Run:

```bash
cd apps/desktop
npm exec --yes pnpm@10.11.0 -- build
```

Expected: PASS

**Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/platform/macos/permissions.rs \
        apps/desktop/src-tauri/src/commands.rs \
        apps/desktop/src-tauri/src/app.rs \
        packages/desktop-native-apis/src/bindings.ts \
        apps/desktop/src/utils/permission.utils.ts
git commit -m "feat: add macos screen recording permission commands"
```

### Task 4: Implement the macOS screen-capture OCR provider

**Files:**
- Create: `apps/desktop/src-tauri/src/platform/macos/screen_capture.rs`
- Modify: `apps/desktop/src-tauri/src/platform/macos/mod.rs`
- Modify: `apps/desktop/src-tauri/src/commands.rs`
- Modify: `apps/desktop/src/types/accessibility.types.ts`
- Create: `apps/desktop/src/utils/screen-context-provider.ts`
- Test: `apps/desktop/src/actions/transcribe.context.test.ts`

**Step 1: Write the failing test**

Add a focused test that expects finalize-time context to include OCR context when the provider returns it:

```ts
it("merges screen-capture OCR context into finalize-time dictation context", async () => {
  const result = await resolveDesktopDictationContext({
    currentApp: { id: "chat", name: "Chat" },
    a11yInfo: null,
    screenContext: "Accessibility context",
    screenCaptureContext: "OCR names and events",
  });

  expect(result.screenContext).toContain("OCR names and events");
});
```

**Step 2: Run the test to verify it fails**

Run:

```bash
cd apps/desktop
npm exec --yes pnpm@10.11.0 -- vitest run src/actions/transcribe.context.test.ts
```

Expected: FAIL because there is no screen-capture provider or merge path yet

**Step 3: Write the minimal implementation**

- Create `screen_capture.rs` with:
  - active-window discovery
  - one-image ScreenCaptureKit capture
  - Vision OCR extraction
  - a small result type that returns `Option<String>`
- Export the module from `platform/macos/mod.rs`.
- Add a new Tauri command, for example `get_screen_capture_context`, in `commands.rs`.
- Create `screen-context-provider.ts` to call the command and normalize failures to `null`.
- Extend `ScreenContextInfo` only if needed to model both accessibility and OCR inputs cleanly.

**Step 4: Run the test to verify it passes**

Run:

```bash
cd apps/desktop
npm exec --yes pnpm@10.11.0 -- vitest run src/actions/transcribe.context.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/platform/macos/screen_capture.rs \
        apps/desktop/src-tauri/src/platform/macos/mod.rs \
        apps/desktop/src-tauri/src/commands.rs \
        apps/desktop/src/types/accessibility.types.ts \
        apps/desktop/src/utils/screen-context-provider.ts \
        apps/desktop/src/actions/transcribe.context.test.ts
git commit -m "feat: add macos screen capture context provider"
```

### Task 5: Wire finalize-time capture into dictation fallback logic

**Files:**
- Modify: `apps/desktop/src/components/root/DictationSideEffects.tsx`
- Modify: `apps/desktop/src/actions/transcribe.actions.ts`
- Modify: `apps/desktop/src/utils/prompt.utils.ts`
- Modify: `apps/desktop/src/utils/prompt.utils.test.ts`
- Modify: `apps/desktop/src/actions/transcribe.actions.test.ts`
- Modify: `apps/desktop/test/integration/post-processing-stability.test.ts`

**Step 1: Write the failing test**

Add a failing assertion that the prompt picks up OCR context when available and still works without it:

```ts
expect(prompt).toContain("Screen context: OCR names and events");
expect(promptWithoutOcr).not.toContain("Screen context:");
```

**Step 2: Run the tests to verify they fail**

Run:

```bash
cd apps/desktop
npm exec --yes pnpm@10.11.0 -- vitest run src/actions/transcribe.actions.test.ts src/utils/prompt.utils.test.ts test/integration/post-processing-stability.test.ts
```

Expected: FAIL because finalize-time wiring does not pass through OCR capture yet

**Step 3: Write the minimal implementation**

- In `DictationSideEffects.tsx`, fetch screen-capture OCR context at finalize time in parallel with the existing accessibility context.
- Merge OCR context into the single `screenContext` payload before calling `resolveDesktopDictationContext`.
- Keep the current fallback semantics: if capture is unavailable or permission is missing, continue with accessibility-derived context only.
- Preserve existing prompt-size limits in `transcribe.actions.ts` / `prompt.utils.ts`.

**Step 4: Run the tests to verify they pass**

Run:

```bash
cd apps/desktop
npm exec --yes pnpm@10.11.0 -- vitest run src/actions/transcribe.actions.test.ts src/utils/prompt.utils.test.ts test/integration/post-processing-stability.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add apps/desktop/src/components/root/DictationSideEffects.tsx \
        apps/desktop/src/actions/transcribe.actions.ts \
        apps/desktop/src/utils/prompt.utils.ts \
        apps/desktop/src/utils/prompt.utils.test.ts \
        apps/desktop/src/actions/transcribe.actions.test.ts \
        apps/desktop/test/integration/post-processing-stability.test.ts
git commit -m "feat: use screen capture context during finalize"
```

### Task 6: Validate, document, and open the separate PR

**Files:**
- Modify: `docs/dictation-accuracy.md`
- Modify: `mobile/README.md`
- Modify: `README.md`

**Step 1: Update the docs**

Document that:

- macOS now supports optional finalize-only screen-capture OCR context
- the feature falls back cleanly when permission is unavailable
- the shared dictation context contract remains reusable for future Windows/Linux/mobile implementations

**Step 2: Run the focused validation suite**

Run:

```bash
cd apps/desktop
npm exec --yes pnpm@10.11.0 -- vitest run \
  src/utils/permission-flow.utils.test.ts \
  src/actions/transcribe.actions.test.ts \
  src/actions/transcribe.context.test.ts \
  src/utils/prompt.utils.test.ts \
  test/integration/post-processing-stability.test.ts
npm exec --yes pnpm@10.11.0 -- build
npm exec --yes pnpm@10.11.0 -- build:tauri:local
```

Expected: all tests pass and both builds succeed

**Step 3: Manually validate the local macOS app**

Run:

```bash
npm exec --yes pnpm@10.11.0 -- install:mac-local
open /Applications/Voquill\\ \\(local\\).app
```

Expected:

- screen-recording permission can be requested
- dictation still works when the permission is denied
- OCR context is used when permission is granted

**Step 4: Commit the final docs/validation changes**

```bash
git add README.md docs/dictation-accuracy.md mobile/README.md
git commit -m "docs: record screen capture context support"
```

**Step 5: Push and create the separate PR**

```bash
git push -u origin feat/screen-capture-context
gh pr create --repo voquill/voquill --base main --head goyal-chintan:feat/screen-capture-context
```
