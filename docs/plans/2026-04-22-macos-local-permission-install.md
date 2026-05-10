# macOS Local Permission and Install Isolation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the recursive startup permission flow in the macOS local desktop app, then rebuild and replace `/Applications/Voquill (local).app` so the user can validate dictation safely in a single-app test setup.

**Architecture:** Keep the official and local bundle identities separate. Add a small, explicit client-side permission lifecycle for the local app so startup permission checks become stable instead of recursive, then use the existing local Tauri config to build and replace only `Voquill (local).app`.

**Tech Stack:** TypeScript, React, Zustand app state, Rust/Tauri, Vitest, Node.js scripts, pnpm workspace, macOS TCC/accessibility APIs

---

### Task 1: Model a non-recursive accessibility permission lifecycle

**Files:**
- Modify: `apps/desktop/src/types/permission.types.ts`
- Modify: `apps/desktop/src/utils/permission.utils.ts`
- Modify: `apps/desktop/src-tauri/src/platform/macos/permissions.rs`
- Create: `apps/desktop/src/utils/permission-flow.utils.ts`
- Create: `apps/desktop/src/utils/permission-flow.utils.test.ts`

**Step 1: Write the failing test**

Add failing tests for a pure permission-flow helper that prove:
- accessibility `trusted=false` does **not** immediately become a hard denied UI state
- once the user has already initiated the request, the UI can enter a “waiting for external approval” state
- a repeated refresh while waiting does not ask to reopen Settings again

Example test shape:

```ts
import { describe, expect, it } from "vitest";
import { derivePermissionGateState } from "./permission-flow.utils";

describe("derivePermissionGateState", () => {
  it("treats an untrusted accessibility check as not-yet-granted before request", () => {
    expect(
      derivePermissionGateState({
        kind: "accessibility",
        status: { kind: "accessibility", state: "not-determined", promptShown: false },
        requestInFlight: false,
        awaitingExternalApproval: false,
      }),
    ).toMatchObject({ canRequest: true, shouldOpenSettings: false });
  });
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd /Users/chintan/Personal/repos/voquill/.worktrees/dictation-accuracy-core
npm exec --yes pnpm@10.11.0 -- --filter desktop exec vitest run src/utils/permission-flow.utils.test.ts
```

Expected: FAIL because the helper and the expanded permission lifecycle do not exist yet.

**Step 3: Write minimal implementation**

- Add a small pure helper in `permission-flow.utils.ts` that derives:
  - whether a permission can be requested now
  - whether the UI is waiting for an external System Settings change
  - whether Settings should be opened again
- Update `permission.types.ts` only as much as needed to represent the local lifecycle cleanly.
- In `macos/permissions.rs`, stop mapping every `AXIsProcessTrusted() == false` check to a hard denied result during passive checks.
- Keep `request_accessibility_permission()` focused on one request transition instead of trying to simulate the entire UI flow.

Minimal implementation sketch:

```rs
pub(crate) fn check_accessibility_permission() -> Result<PermissionStatus, String> {
    let trusted = unsafe { AXIsProcessTrusted() };
    Ok(PermissionStatus {
        kind: PermissionKind::Accessibility,
        state: if trusted {
            PermissionState::Authorized
        } else {
            PermissionState::NotDetermined
        },
        prompt_shown: false,
    })
}
```

**Step 4: Run test to verify it passes**

Run the same command and confirm PASS.

**Step 5: Commit**

```bash
git add apps/desktop/src/types/permission.types.ts apps/desktop/src/utils/permission.utils.ts apps/desktop/src-tauri/src/platform/macos/permissions.rs apps/desktop/src/utils/permission-flow.utils.ts apps/desktop/src/utils/permission-flow.utils.test.ts
git commit -m "fix: model macos accessibility permission flow"
```

### Task 2: Wire startup, dialog, and onboarding to the shared permission gate

**Files:**
- Modify: `apps/desktop/src/state/app.state.ts`
- Modify: `apps/desktop/src/components/root/PermissionSideEffects.tsx`
- Modify: `apps/desktop/src/components/dashboard/PermissionsDialog.tsx`
- Modify: `apps/desktop/src/components/onboarding/A11yPermsForm.tsx`
- Modify: `apps/desktop/src/components/onboarding/MicPermsForm.tsx`
- Test: `apps/desktop/src/utils/permission-flow.utils.test.ts`

**Step 1: Write the failing test**

Extend `permission-flow.utils.test.ts` with failing cases that prove:
- once the accessibility request has been triggered, repeated polling keeps the app in a waiting state instead of asking again
- onboarding/dialog actions are disabled or ignored while a request is already active
- a granted transition clears the waiting state cleanly

Example addition:

```ts
it("does not reopen accessibility settings while already awaiting approval", () => {
  expect(
    derivePermissionGateState({
      kind: "accessibility",
      status: { kind: "accessibility", state: "not-determined", promptShown: false },
      requestInFlight: false,
      awaitingExternalApproval: true,
    }),
  ).toMatchObject({ canRequest: false, shouldOpenSettings: false });
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd /Users/chintan/Personal/repos/voquill/.worktrees/dictation-accuracy-core
npm exec --yes pnpm@10.11.0 -- --filter desktop exec vitest run src/utils/permission-flow.utils.test.ts
```

Expected: FAIL because the store/components are not yet using the shared permission gate metadata.

**Step 3: Write minimal implementation**

- Add the smallest app-state metadata needed to remember whether a permission request is in flight or awaiting an external change.
- Update `PermissionSideEffects.tsx` so it only refreshes permission status; it must not implicitly retrigger requests.
- Update `PermissionsDialog.tsx`, `A11yPermsForm.tsx`, and `MicPermsForm.tsx` to:
  - request once
  - store the request lifecycle metadata
  - rely on the shared gate helper for button state and messaging

Minimal state shape sketch:

```ts
type PermissionRequestMeta = {
  inFlight: boolean;
  awaitingExternalApproval: boolean;
};
```

**Step 4: Run focused tests to verify it passes**

Run:

```bash
cd /Users/chintan/Personal/repos/voquill/.worktrees/dictation-accuracy-core
npm exec --yes pnpm@10.11.0 -- --filter desktop exec vitest run src/utils/permission-flow.utils.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/desktop/src/state/app.state.ts apps/desktop/src/components/root/PermissionSideEffects.tsx apps/desktop/src/components/dashboard/PermissionsDialog.tsx apps/desktop/src/components/onboarding/A11yPermsForm.tsx apps/desktop/src/components/onboarding/MicPermsForm.tsx apps/desktop/src/utils/permission-flow.utils.test.ts
git commit -m "fix: stop recursive permission prompts in desktop startup"
```

### Task 3: Add a safe local install helper for `Voquill (local).app`

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/src-tauri/tauri.local.conf.json` (only if local bundle metadata needs a targeted tweak)
- Create: `apps/desktop/scripts/install-local-macos.mjs`
- Create: `apps/desktop/scripts/install-local-macos.test.mjs`

**Step 1: Write the failing test**

Create a small Node test that proves the install helper:
- targets `/Applications/Voquill (local).app`
- never targets `/Applications/Voquill.app`
- supports a dry-run mode so path logic is testable without touching the real app

Example:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { getInstallPlan } from "./install-local-macos.mjs";

test("install plan only replaces the local app bundle", () => {
  const plan = getInstallPlan("/tmp/Voquill (local).app");
  assert.equal(plan.targetAppPath, "/Applications/Voquill (local).app");
  assert.notEqual(plan.targetAppPath, "/Applications/Voquill.app");
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd /Users/chintan/Personal/repos/voquill/.worktrees/dictation-accuracy-core/apps/desktop
node --test scripts/install-local-macos.test.mjs
```

Expected: FAIL because the helper script does not exist yet.

**Step 3: Write minimal implementation**

- Add `install-local-macos.mjs` with:
  - a pure `getInstallPlan()` helper
  - a dry-run option
  - safe replacement of only the local app bundle
- Add package scripts for building and installing the local desktop app.

Minimal helper sketch:

```js
export function getInstallPlan(sourceAppPath) {
  return {
    sourceAppPath,
    targetAppPath: "/Applications/Voquill (local).app",
  };
}
```

Package script sketch:

```json
{
  "build:tauri:local": "pnpm run prepare:sidecars && pnpm tauri build --config src-tauri/tauri.local.conf.json",
  "install:mac-local": "node scripts/install-local-macos.mjs"
}
```

**Step 4: Run test to verify it passes**

Run:

```bash
cd /Users/chintan/Personal/repos/voquill/.worktrees/dictation-accuracy-core/apps/desktop
node --test scripts/install-local-macos.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add package.json src-tauri/tauri.local.conf.json scripts/install-local-macos.mjs scripts/install-local-macos.test.mjs
git commit -m "feat: add safe local macos install helper"
```

### Task 4: Run focused verification, build the local app, and replace the installed local bundle

**Files:**
- Modify only if verification exposes a small targeted bug

**Step 1: Run focused verification**

Run:

```bash
cd /Users/chintan/Personal/repos/voquill/.worktrees/dictation-accuracy-core
npm exec --yes pnpm@10.11.0 -- --filter desktop exec vitest run src/utils/permission-flow.utils.test.ts src/strategies/dictation.strategy.test.ts src/utils/prompt.utils.test.ts src/actions/transcribe.actions.test.ts src/actions/transcribe.context.test.ts src/repos/transcribe-audio.repo.test.ts src/sessions/new-server-transcription-session.test.ts src/repos/transcription.repo.test.ts test/integration/post-processing-stability.test.ts
npm exec --yes pnpm@10.11.0 -- --filter desktop build
```

Expected: PASS for the touched desktop surfaces.

**Step 2: Build the local macOS app bundle**

Run:

```bash
cd /Users/chintan/Personal/repos/voquill/.worktrees/dictation-accuracy-core/apps/desktop
npm exec --yes pnpm@10.11.0 -- run build:tauri:local
```

Expected: a fresh local bundle at a Tauri macOS bundle path such as:

```text
src-tauri/target/release/bundle/macos/Voquill (local).app
```

**Step 3: Quit both installed apps and replace only the local app**

Run:

```bash
osascript -e 'tell application "Voquill" to quit' || true
osascript -e 'tell application "Voquill (local)" to quit' || true
cd /Users/chintan/Personal/repos/voquill/.worktrees/dictation-accuracy-core/apps/desktop
node scripts/install-local-macos.mjs
```

Expected: `/Applications/Voquill (local).app` is replaced; `/Applications/Voquill.app` is untouched.

**Step 4: Launch the local app and validate the startup flow**

Run:

```bash
open -a "/Applications/Voquill (local).app"
```

Validate:
- only the local app is running for the test session
- startup permission gate appears if permissions are missing
- no recursive prompt loop occurs
- once permissions are granted, the app becomes usable
- dictation still works with the current accuracy/context branch

**Step 5: Commit**

```bash
git add .
git commit -m "fix: stabilize local macos permissions and install flow"
```
