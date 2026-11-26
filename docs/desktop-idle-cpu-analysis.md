# Desktop App Idle CPU Analysis

The desktop app consumes ~10% CPU while idle. This document identifies the root causes and proposes fixes.

## Top Offenders

### 1. Cursor Follower Thread (Critical)

**File:** `apps/desktop/src-tauri/src/overlay.rs:410-432`
**Impact:** Highest — dedicated thread wakes ~16.7 times/sec

A background thread polls cursor position every 60ms in an infinite loop:

```rust
loop {
    std::thread::sleep(Duration::from_millis(CURSOR_POLL_INTERVAL_MS)); // 60ms
    update_cursor_follower(&app, &state);
}
```

Each tick calls `get_monitor_at_cursor()` (platform API), checks hover bounds, manages pill animation state, and potentially resizes/repositions overlay windows. This runs **unconditionally** — even when the main window is closed, the pill overlay is hidden, or the app is completely idle.

On Linux, the same logic uses a GTK timer (`overlay.rs:383-407`).

**Fix options:**
- Increase poll interval to 200ms when idle, 60ms only when the pill is visible/active.
- Stop the cursor follower entirely when the pill overlay is not shown.
- On macOS, consider using `CGEvent` tap or `NSEvent.addGlobalMonitorForEvents` for cursor-moved events instead of polling.

### 2. Permission Polling (High)

**File:** `apps/desktop/src/components/root/PermissionSideEffects.tsx:50`
**Impact:** High — Tauri IPC round-trip every 1 second

```tsx
useIntervalAsync(1000, refreshPermissions, [refreshPermissions]);
```

Checks microphone and accessibility permissions every 1 second via two Tauri commands. Each check crosses the IPC bridge and invokes platform APIs. Permissions change extremely rarely during a session.

**Fix options:**
- Increase interval to 30 seconds.
- Check on mount + on app focus (`visibilitychange` / Tauri `focus` event) instead of polling.
- Use platform-specific permission change observers if available.

### 3. Keyboard Listener Busy-Wait (High)

**File:** `apps/desktop/src-tauri/src/platform/keyboard.rs:235-267`
**Impact:** High — thread wakes ~20 times/sec

The keyboard listener uses a non-blocking TCP socket. When no connection is pending, `accept()` returns `WouldBlock` and the thread sleeps 50ms before retrying:

```rust
Err(err) if err.kind() == ErrorKind::WouldBlock => {
    thread::sleep(Duration::from_millis(50));
}
```

This is a classic busy-wait pattern — the thread wakes 20 times per second to check if there's a connection.

**Fix options:**
- Switch to blocking mode with `set_nonblocking(false)` and use `set_read_timeout(Some(Duration::from_secs(1)))` so the thread blocks on the OS kernel instead of spinning.
- Alternatively, use `mio` or `polling` crate for event-driven accept.

## Secondary Contributors

### 4. `useIntervalAsync` Timers in Side Effects

**File:** `apps/desktop/src/components/root/AppSideEffects.tsx`

Multiple intervals run continuously:

| Interval | Purpose | Line |
|----------|---------|------|
| 60s | Enterprise target refresh | 290 |
| 60s | App update check | 566 |
| 5min | Token refresh | 334 |
| 10min | Config refresh | 278 |
| 10min | Session heartbeat | `SessionSideEffects.tsx` |
| 15min | Member/user data refresh | `RootSideEffects.ts:55` |

These are individually low-impact but collectively add up. The 60-second intervals (enterprise target, update check) are worth reviewing — they could be less frequent or event-driven.

### 5. CSS Infinite Animations

Several components use `animation: infinite` CSS keyframes that run even when not visible:

- `Liquid.tsx` — 4 rotating wave animations (40-50s cycles)
- `DiscordListTile.tsx` — pulsing badge (1.5s)
- `MobileAppListTile.tsx` — shimmer effect (3s)
- `UpdateListTile.tsx` — shimmer effect (3s)
- `ChatMessageBubble.tsx` / `AssistantModePanel.tsx` — thinking shimmer (1.6s)

These are GPU-accelerated via `transform`/`opacity` so they have minimal CPU impact individually, but if the webview doesn't properly compositor-offload them, they can contribute.

### 6. Rust Background Threads (Low)

These run but are efficient (blocking on I/O, not spinning):

- **Audio feedback thread** (`audio_feedback.rs`) — blocks on `mpsc::Receiver::recv()`, zero CPU when idle.
- **Bridge server** (`bridge_server.rs`) — async `listener.accept().await`, zero CPU when idle.
- **Remote receiver** (`remote_receiver.rs`) — async with `tokio::select!`, zero CPU when idle.
- **Pill stdout reader** (`pill_process.rs`) — blocking `read_line`, zero CPU when idle.

## Recommended Priority

1. **Cursor follower** — Biggest single source. Add idle/active modes or stop when pill is hidden.
2. **Permission polling** — Change to event-driven (app focus) + long interval fallback (30s).
3. **Keyboard listener** — Switch to blocking accept with timeout.
4. **60s intervals** — Increase enterprise/update check to 5-10 minutes.
