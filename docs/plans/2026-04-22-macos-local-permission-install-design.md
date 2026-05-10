# macOS Local Permission and Install Isolation Design

## Summary
Stabilize the macOS local desktop app for testing by fixing the recursive startup permission flow and replacing only `/Applications/Voquill (local).app`. This phase follows the approved **single-app isolation during testing** approach: keep the official app out of the live test loop, preserve the local bundle identity, and validate the current dictation accuracy/context pipeline inside the local app only.

## Goals
- Stop recursive accessibility and microphone prompting in the local macOS app.
- Require the necessary permissions at startup without reopening requests in a loop.
- Keep testing isolated to `Voquill (local).app`.
- Replace the currently installed local app with a fresh build that is ready for user testing.
- Preserve the accuracy/context work already implemented in the current feature branch.

## Non-goals
- Redesigning full coexistence UX for running both installed apps in the same session.
- Renaming the local app to the official app name or reusing the official bundle identifier.
- Changing the official `/Applications/Voquill.app` as part of the default flow.

## Approved Approach
Use the local app as the only active test client:

1. Keep `/Applications/Voquill (local).app` on `com.voquill.desktop.local`.
2. Quit both installed apps before validation and run only the local app.
3. Fix the permission state machine so startup checks are informative but non-recursive.
4. Rebuild and replace only the local app bundle.

This is the fastest path to a stable local test app while still addressing the actual prompt-loop bug.

## Key Findings From Audit
- The official and local apps do **not** appear to share a bundle identity.
- The likely root cause is the app’s permission flow:
  - accessibility false is treated as denied too early
  - requesting accessibility both prompts and opens System Settings immediately
  - permission state is rechecked every second
  - onboarding/dialog actions can retrigger the same request path
- The safest install target is still `/Applications/Voquill (local).app`, not `/Applications/Voquill.app`.

## Architecture

### 1. Permission state model
The local app needs a stricter client-side permission lifecycle on top of the native permission checks.

- Native accessibility checks should not collapse every `AXIsProcessTrusted() == false` result into a hard denied state.
- The desktop app should track whether a permission request has already been initiated and whether the app is now waiting for an external System Settings change.
- Startup polling may continue to observe permission state changes, but it must not trigger repeated requests or repeatedly reopen Settings.

### 2. Startup permission gate
The app should enter a stable permission gate on startup:

- If required permissions are already granted, normal app flow continues.
- If permissions are missing, the app presents a gate/dialog/onboarding state.
- User actions can open the relevant request/settings path once.
- While waiting for the system to reflect a change, the app stays blocked but calm.

### 3. Local install isolation
The local installation flow remains explicitly separate:

- build with `src-tauri/tauri.local.conf.json`
- replace only `/Applications/Voquill (local).app`
- avoid touching `Voquill.app`
- avoid changing the local bundle identifier to the official one

For validation, the official app may remain installed, but it should not be running. If its mere presence still interferes, temporary removal or relocation is a fallback, not the default.

## Data / Control Flow
1. App starts.
2. `PermissionSideEffects` performs a read-only permission refresh.
3. Permission UI derives a stable gate state from:
   - native permission status
   - whether a request was already initiated
   - whether the app is awaiting an external change
4. User triggers a permission request once.
5. Native layer shows the system prompt or opens the correct Settings pane.
6. Polling observes status changes without re-triggering requests.
7. Once authorized, the app becomes usable without recursive reopen behavior.

## Validation Plan
- Focused unit tests for permission-state derivation and request gating.
- Focused desktop tests for permission UI/controller behavior.
- Desktop build using local Tauri config.
- Replacement of `/Applications/Voquill (local).app`.
- Manual launch validation:
  - startup gate appears if needed
  - no recursive accessibility/microphone prompt loop
  - app becomes usable after permissions are granted
  - dictation still works on the local app

## Risks and Guardrails
- macOS TCC internals cannot be relied on directly in this environment, so the flow must be robust without DB inspection.
- Local builds may behave differently if signing/notarization changes; installation should keep one stable local identity.
- The isolation-first approach deliberately optimizes for a stable local app first, not simultaneous dual-app operation.
