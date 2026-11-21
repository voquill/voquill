# Pill Flash Message

A flash message is a temporary notification that appears above the pill in dictation mode. It replaces the language/style switcher tooltip while visible, then smoothly disappears and returns control to the tooltip.

This feature was implemented for the macOS pill (`packages/rust_macos_pill`). This document specifies the behavior, layout, animation, and IPC contract so the same feature can be replicated in the GTK pill (`packages/rust_gtk_pill`) and any future platform implementations.

## IPC Message

```json
{"type": "flash_message", "message": "Copied to clipboard"}
```

| Field     | Type   | Description                        |
| --------- | ------ | ---------------------------------- |
| `message` | string | The text to display in the banner. |

Add `FlashMessage { message: String }` to the `InMessage` enum (serde tag: `flash_message`). There is no outbound message — this is fire-and-forget from the host.

When a new `flash_message` arrives while one is already showing, it replaces the current message and resets the timer.

## Behavior

- Flash messages only appear in **dictation mode** (not assistant mode).
- While a flash message is visible, the **style/language switcher tooltip is hidden**. Once the flash fades out, the tooltip resumes normal behavior.
- The message is non-interactive — no click regions are registered.
- There is no queue; a new flash message replaces any active one.

## Visibility while a flash is showing

A flash message (and a `toast`, `fireworks` or `flame`, which drive the same banner) must be seen even when the user's `dictationPillVisibility` would hide the pill, e.g. "Copied to clipboard" right after a dictation ends with the pill set to `hidden` or `while_active`.

The host decides this, not the pill. Whenever the TypeScript side sends one of those messages it holds the pill visible: it sends `{"type":"visibility","visibility":"persistent"}` until the banner's display duration plus its exit animation (`PILL_FLASH_EXIT_ANIMATION_MS`, 750 ms, which covers the ~0.6 s spring settle) has elapsed. Then it sends the user's setting again. `dismiss_toast` shortens the hold to just the exit animation. Overlapping flashes extend the hold and never shorten it. See `holdPillVisibleForFlash` in `apps/desktop/src/utils/overlay.utils.ts` and `getPillVisibilityToApply` in `apps/desktop/src/utils/user.utils.ts`.

To keep the two sides in step, the host always sends an explicit `duration` on `toast` messages instead of relying on the pills' `FLASH_DURATION` default. `fireworks` and `flame` have no duration field, so the host mirrors `FIREWORKS_TOTAL_DURATION` (7 s) and `FLAME_TOTAL_DURATION` (5 s); keep those in sync. `dismiss_toast` only shortens the toast's hold to its exit animation — a fireworks/flame animation keeps its own hold — and does nothing when no toast is held, so it cannot flash a hidden pill.

Pills need no extra logic for this on macOS, Windows or X11: they just honour `visibility`.

The GTK pill on Wayland (layer-shell and plain) is the one exception, and it is deliberate. Its window policy is already decided natively: it ignores `visibility` entirely and only shows while recording, because the plain-Wayland window is a maximised transparent dock and showing it outside dictation would cover the screen. TypeScript has no way to say "show only for this flash" through `visibility` without also turning on the persistent pill for every Wayland user (the default setting is `persistent`). So on Wayland only, the pill also stays shown while `flash_visible` is set or `flash_t > 0.01`, which is exact with respect to its own animation.

## State

Add the following fields to `PillState`:

| Field            | Type           | Default          | Description                                           |
| ---------------- | -------------- | ---------------- | ----------------------------------------------------- |
| `flash_message`  | `String`       | `""` (empty)     | The current message text.                             |
| `flash_visible`  | `bool`         | `false`          | Whether the display timer is active.                  |
| `flash_t`        | `f64`          | `0.0`            | Spring-animated progress `0.0 → 1.0` (appear/disappear). |
| `flash_velocity` | `f64`          | `0.0`            | Spring velocity for `flash_t`.                        |
| `flash_timer`    | `f64` (seconds) | `0.0`           | Countdown — when it reaches 0, `flash_visible` becomes false. |

### IPC handler

When `FlashMessage { message }` is received:

```
state.flash_message  = message
state.flash_visible  = true
state.flash_timer    = FLASH_DURATION   // 2.5 seconds
```

## Constants

| Constant          | Value  | Description                                               |
| ----------------- | ------ | --------------------------------------------------------- |
| `FLASH_DURATION`  | `2.5`  | Seconds the message stays visible before fading out.      |
| `FLASH_HEIGHT`    | `32.0` | Height of the flash banner (matches tooltip height).      |
| `FLASH_RADIUS`    | `12.0` | Corner radius (matches tooltip radius).                   |
| `FLASH_GAP`       | `6.0`  | Vertical gap between the pill's top edge and the banner's bottom edge. |
| `FLASH_PADDING_H` | `16.0` | Horizontal padding on each side of the text.              |
| `FLASH_MIN_SCALE` | `0.5`  | Initial scale factor when appearing (50%).                |

## Animation

### Tick logic (runs every frame)

```
if flash_visible:
    flash_timer -= dt
    if flash_timer <= 0:
        flash_visible = false
        flash_timer = 0

flash_target = 1.0 if flash_visible else 0.0
spring_anim(flash_t, flash_velocity, flash_target, SPRING_STIFFNESS, dt)
```

The spring animation is identical to the existing tooltip, panel, and expand animations:

```
stiffness = 200.0
damping   = 2 * sqrt(stiffness)    // critically damped
force     = stiffness * (target - value) - damping * velocity
velocity += force * dt
value    += velocity * dt
```

Settle threshold: snap to target when `|value - target| < 0.002` and `|velocity| < 0.5`.

This produces a smooth ease-in on appear and a smooth ease-out on disappear, with no overshoot.

### Visual properties derived from `flash_t`

| Property     | Formula                                     | At `flash_t=0` | At `flash_t=1` |
| ------------ | ------------------------------------------- | --------------- | --------------- |
| Scale        | `FLASH_MIN_SCALE + (1 - FLASH_MIN_SCALE) * flash_t` | 0.50 (50%)  | 1.00 (100%)     |
| Opacity (bg) | `0.92 * flash_t`                            | 0.0 (invisible) | 0.92            |
| Opacity (text)| `0.9 * flash_t`                            | 0.0 (invisible) | 0.9             |

The scale transform is applied around the **center** of the banner (not the corner), so it grows outward symmetrically.

## Layout & Positioning

The flash banner is anchored to the **pill's current top edge**, not to a fixed position. This means it smoothly tracks the pill as it expands and collapses.

```
(_, pill_y, _, _) = pill_position(state, ww, wh)

flash_w  = max(text_width + FLASH_PADDING_H * 2, 80.0)
flash_x  = (window_width - flash_w) / 2.0        // horizontally centered
flash_y  = pill_y - FLASH_GAP - FLASH_HEIGHT      // above the pill
```

Where `pill_position()` returns the pill's animated position based on `expand_t`. In dictation mode, the pill Y is:

```
collapsed_bottom = 4.0
expanded_bottom  = (PILL_AREA_HEIGHT - EXPANDED_PILL_HEIGHT) / 2.0
bottom_offset    = lerp(collapsed_bottom, expanded_bottom, expand_t)
pill_y           = window_height - bottom_offset - pill_height
```

So when the pill is collapsed (small, near the bottom), the flash sits lower. When expanded (recording/hovered), it rises with the pill.

### Width behavior

The banner width is **dynamic** — it sizes to fit the message text:

```
flash_w = max(text_extents.width + FLASH_PADDING_H * 2, 80.0)
```

Minimum width is 80px to prevent absurdly narrow banners on short messages.

## Drawing

### Render order in `draw_all()`

In dictation mode, the draw order is (back to front):

```
1. Tooltip           (only when flash_t < 0.01)
2. Pill
3. Cancel button
4. Fireworks          (on top of pill, behind flash)
5. Flash message      (on top of everything)
```

The flash message and tooltip are **mutually exclusive** — only one draws per frame. When `flash_t >= 0.01`, the tooltip is suppressed and the flash message draws on top of fireworks (if active). When `flash_t` drops below `0.01`, the tooltip resumes.

### Drawing steps

1. **Measure text** — `sans-serif`, bold, 12px. Get extents to compute width.
2. **Compute position** — Using pill anchor + gap.
3. **Apply scale transform** — `save()`, translate to center, scale by `scale`, translate back.
4. **Draw background** — Rounded rect, fill with `rgba(0, 0, 0, 0.92 * flash_t)`.
5. **Draw text** — Centered in the banner, `rgba(1, 1, 1, 0.9 * flash_t)`, sans-serif bold 12px.
6. **Restore** — Pop the scale transform.

### Visual appearance

```
┌──────────────────────────────┐
│   Copied to clipboard        │  ← 32px tall, 12px radius corners
└──────────────────────────────┘
           6px gap
     ┌──────────────────┐
     │   ◉ pill ◉       │         ← Pill (expanded or collapsed)
     └──────────────────┘
```

- Background: solid black, 92% opacity (matches tooltip and pill styling).
- Text: white, 90% opacity, sans-serif bold 12px (matches tooltip text style).
- The banner has no border (unlike the pill which has a subtle white border). This is intentional to keep it lightweight and toast-like.

## Testing

The `test.sh` script accepts a `flash` mode:

```bash
./test.sh flash
```

This runs through:

1. **Idle flash** — Pill is idle/persistent, flash message appears and disappears.
2. **Flash during recording** — Flash appears while waveform is active, demonstrating pill-anchored positioning at the expanded height.
3. **Longer message** — Tests dynamic width sizing.
4. **Tooltip recovery** — After all flashes, sets style info and starts recording to verify the tooltip reappears normally.

### Manual IPC testing

Pipe JSON directly to the pill binary:

```bash
echo '{"type":"visibility","visibility":"persistent"}' | cargo run
# In another terminal or via a script:
echo '{"type":"flash_message","message":"Hello world"}'
```

---

# Pill Fireworks

A celebratory particle effect that shoots firework rockets out from the pill, each exploding into radiating sparks. Accompanied by a flash message banner that persists for the duration. Only appears in dictation mode.

## IPC Message

```json
{"type": "fireworks", "message": "Congratulations!"}
```

| Field     | Type   | Description                                         |
| --------- | ------ | --------------------------------------------------- |
| `message` | string | Text for the flash message banner shown during fireworks. |

Add `Fireworks { message: String }` to the `InMessage` enum (serde tag: `fireworks`).

When received, this triggers **both** the fireworks particle system **and** a flash message with a duration matching the fireworks (7 seconds instead of the normal 2.5s).

## State

Add the following fields to `PillState`:

| Field                   | Type           | Default | Description                                 |
| ----------------------- | -------------- | ------- | ------------------------------------------- |
| `fireworks_active`      | `bool`         | `false` | Whether the fireworks system is running.    |
| `fireworks_elapsed`     | `f64`          | `0.0`   | Seconds since fireworks started.            |
| `fireworks_next_launch` | `usize`        | `0`     | Index into the launch schedule.             |
| `fireworks_rockets`     | `Vec<Rocket>`  | `[]`    | Active rockets (rising + exploding).        |

### Rocket struct

```
Rocket {
    x, y: f64              — current position
    vx, vy: f64            — velocity (vy negative = upward)
    trail: Vec<(f64, f64)> — recent positions for trail rendering
    fuse: f64              — seconds until explosion
    phase: RocketPhase     — Rising | Exploding
    num_sparks: usize      — sparks to generate on explosion
    launch_index: usize    — index in FIREWORK_LAUNCHES (for deterministic variety)
    sparks: Vec<Spark>     — explosion particles
    trail_alpha: f64       — trail opacity (fades after explosion)
    color: (f64, f64, f64) — RGB color assigned from FIREWORK_COLORS palette
}
```

### Spark struct

```
Spark {
    x, y: f64    — current position
    vx, vy: f64  — velocity (with drag)
    life: f64    — 1.0 → 0.0 (used for alpha)
}
```

### IPC handler

When `Fireworks { message }` is received:

```
// Trigger flash message for the full duration
flash_message  = message
flash_visible  = true
flash_timer    = FIREWORKS_TOTAL_DURATION  // 7.0s

// Reset fireworks
fireworks_active      = true
fireworks_elapsed     = 0.0
fireworks_next_launch = 0
fireworks_rockets.clear()
```

## Constants

| Constant                       | Value  | Description                                          |
| ------------------------------ | ------ | ---------------------------------------------------- |
| `FIREWORKS_TOTAL_DURATION`     | `7.0`  | Total duration in seconds.                           |
| `FIREWORKS_GRAVITY`            | `40.0` | Downward acceleration (px/s²). Rockets feel this fully; sparks at 30%. |
| `FIREWORKS_SPARK_BASE_SPEED`   | `85.0` | Base outward speed of explosion sparks (px/s).       |
| `FIREWORKS_SPARK_LIFE`         | `1.1`  | Spark lifetime in seconds (life decrements by `dt / LIFE`). |
| `FIREWORKS_SPARK_DRAG`         | `1.2`  | Exponential drag coefficient for sparks.             |
| `FIREWORKS_TRAIL_MAX`          | `15`   | Max trail points stored per rocket.                  |
| `FIREWORKS_TRAIL_FADE_RATE`    | `2.0`  | Trail alpha decay rate per second after explosion.   |
| `FIREWORKS_ROCKET_LINE_WIDTH`  | `1.8`  | Stroke width for rocket trails.                      |
| `FIREWORKS_SPARK_LINE_WIDTH`   | `1.2`  | Stroke width for spark lines.                        |
| `FIREWORKS_HEAD_SIZE`          | `4.0`  | Diameter of rocket head dot (px).                    |

### Color palette

Each rocket is assigned a color from `FIREWORK_COLORS` based on its launch index (`index % len`). The palette:

| Index | Color       | RGB                 |
| ----- | ----------- | ------------------- |
| 0     | Coral red   | `(1.0, 0.4, 0.3)`  |
| 1     | Sky blue    | `(0.3, 0.8, 1.0)`  |
| 2     | Gold        | `(1.0, 0.85, 0.2)` |
| 3     | Green       | `(0.4, 1.0, 0.5)`  |
| 4     | Pink        | `(1.0, 0.5, 0.9)`  |
| 5     | Lavender    | `(0.5, 0.6, 1.0)`  |
| 6     | Orange      | `(1.0, 0.65, 0.2)` |
| 7     | Cyan        | `(0.3, 1.0, 0.9)`  |
| 8     | Hot pink    | `(1.0, 0.35, 0.5)` |
| 9     | Purple      | `(0.7, 0.5, 1.0)`  |

All drawing (trail, head, sparks) for a given rocket uses its assigned color. The flash message banner remains white text on black — only the firework particles are colored.

### Launch schedule

10 rockets launched at predetermined times, alternating left and right. Each entry defines the launch time, angle (degrees from vertical, negative = left), ascent speed, fuse duration, and spark count.

| #  | Time | Angle | Speed | Fuse | Sparks |
| -- | ---- | ----- | ----- | ---- | ------ |
| 0  | 0.2s | -25   | 140   | 0.50 | 12     |
| 1  | 0.8s | +30   | 125   | 0.55 | 10     |
| 2  | 1.5s | -15   | 150   | 0.45 | 14     |
| 3  | 2.2s | +40   | 115   | 0.60 | 12     |
| 4  | 3.0s | -35   | 130   | 0.50 | 11     |
| 5  | 3.7s | +20   | 145   | 0.50 | 13     |
| 6  | 4.5s | -40   | 120   | 0.55 | 10     |
| 7  | 5.2s | +15   | 150   | 0.45 | 14     |
| 8  | 5.9s | -30   | 125   | 0.50 | 12     |
| 9  | 6.4s | +35   | 140   | 0.55 | 11     |

Velocity is computed from angle and speed:

```
vx =  speed * sin(angle_rad)
vy = -speed * cos(angle_rad)   // negative = upward (y-down coordinate system)
```

## Physics simulation (per frame)

### Rocket rising

```
vy += GRAVITY * dt            // gravity slows ascent
x  += vx * dt
y  += vy * dt
trail.push((x, y))           // store position for trail
if trail.len > TRAIL_MAX: trail.remove(0)
fuse -= dt
```

### Explosion (fuse <= 0)

Transition to `Exploding` phase. Generate N sparks evenly distributed around a circle:

```
offset = launch_index * 0.7                         // rotation offset for variety
for i in 0..num_sparks:
    angle  = TAU * i / num_sparks + offset
    speed_t = ((i * 7 + 3) % num_sparks) / num_sparks  // deterministic speed variation
    speed   = SPARK_BASE_SPEED * (0.6 + 0.8 * speed_t) // 51–119 px/s range
    spark.vx = speed * cos(angle)
    spark.vy = speed * sin(angle)
    spark.life = 1.0
```

The `(i * 7 + 3) % num_sparks` formula creates deterministic pseudo-random speed variation without actual randomness, ensuring consistent visuals across platforms.

### Spark update

```
drag = exp(-SPARK_DRAG * dt)  // ~0.976 per frame at 60fps
vx *= drag
vy *= drag
vy += GRAVITY * 0.3 * dt     // subtle downward pull
x  += vx * dt
y  += vy * dt
life -= dt / SPARK_LIFE       // 1.0 → 0.0 over SPARK_LIFE seconds
```

### Trail fade (after explosion)

```
trail_alpha -= TRAIL_FADE_RATE * dt   // fades to 0 over ~0.5s
```

### Cleanup

A rocket is removed when `phase == Exploding` AND `trail_alpha <= 0.01` AND all sparks have `life <= 0.0`.

The entire fireworks system deactivates when `elapsed >= TOTAL_DURATION` AND no rockets remain.

## Drawing

### Launch origin

Rockets launch from the **center of the flash message banner**, not from the pill. This makes the fireworks appear to burst out of the message:

```
(_, pill_y, _, _) = pill_position(state, ww, wh)
origin_x = ww / 2.0
origin_y = pill_y - FLASH_GAP - FLASH_HEIGHT / 2.0   // center of flash banner
```

### Rocket trail

Draw connected line segments between stored trail points. Older points are more transparent, using the rocket's assigned color:

```
(cr, cg, cb) = rocket.color
for i in 1..trail.len():
    alpha = (i / trail.len()) * trail_alpha * 0.8
    draw line from trail[i-1] to trail[i], (cr, cg, cb) at alpha, width 1.8px
```

### Rocket head (rising only)

A filled `HEAD_SIZE` x `HEAD_SIZE` circle (rounded rect with `HEAD_SIZE/2` radius) at the rocket's current position, rocket color at 95% opacity.

### Sparks

Each spark is drawn as a short line segment in its direction of travel (motion blur effect), using the rocket's color:

```
speed    = sqrt(vx² + vy²)
line_len = clamp(speed * 0.04, 2.0, 10.0)
nx, ny   = (vx / speed, vy / speed)    // normalized direction

draw line from (x - nx * line_len, y - ny * line_len) to (x, y)
    rocket color at (life * 0.9), width 1.2px
```

### Coordinate space

Fireworks draw in the pill's content coordinate space (after the `translate(ox, oy)` in `draw_all`). Since the window is larger than the dictation content area (600x362 vs 200x86) and there is no clip to the content bounds, rockets and sparks naturally extend into the transparent space above the pill. This is intentional — explosions happen above the content area and are visible because the window background is clear.

### Visual style

Each rocket has a unique color from the 10-color palette, giving a vibrant celebratory feel. The trail, head dot, and all explosion sparks for a given rocket share its assigned color. The flash message banner itself remains monochrome (white text on black background). The effect is stylistic — line trails and radiating spark lines rather than filled particles.

## Testing

```bash
./test.sh fireworks
```

Runs two consecutive 7-second fireworks displays with different messages.

---

## Platform implementation notes

### GTK pill (`rust_gtk_pill`)

The GTK pill shares the same file structure (`ipc.rs`, `state.rs`, `constants.rs`, `draw.rs`, `input.rs`). To implement both features:

1. **`ipc.rs`** — Add `FlashMessage { message: String }` and `Fireworks { message: String }` to `InMessage`.
2. **`state.rs`** — Add flash state fields (5 fields), fireworks state fields (4 fields), and the `Rocket`/`Spark`/`RocketPhase` structs. Rocket includes a `color: (f64, f64, f64)` field.
3. **`constants.rs`** — Add all flash constants (6), fireworks constants (10 including `HEAD_SIZE`), `FireworkLaunch` struct, `FIREWORK_COLORS` palette, and the `FIREWORK_LAUNCHES` schedule.
4. **Main event handler** — Handle both `FlashMessage` and `Fireworks` IPC. Fireworks triggers flash message with the longer `FIREWORKS_TOTAL_DURATION` timer.
5. **Tick function** — Add flash timer countdown + spring anim. Add `tick_fireworks()` with the full physics simulation (launch schedule, rocket movement, explosion sparks, cleanup). Launch origin is the center of the flash message banner (computed from `pill_position()` + `FLASH_GAP` + `FLASH_HEIGHT`). Assign color from `FIREWORK_COLORS[index % len]`.
6. **`draw.rs`** — Restructure `draw_all` render order (tooltip → pill → cancel → fireworks → flash). Add `draw_flash_message()` and `draw_fireworks()`. The GTK pill uses Cairo which has the same `save`/`translate`/`scale`/`restore`, `move_to`/`line_to`/`stroke`, and `set_source_rgba` primitives.
7. **`test.sh`** — Add `flash` and `fireworks` test modes.

### Windows pill (future)

Follow the same spec. The critical pieces are:
- The spring animation parameters (stiffness 200, critical damping).
- The scale-from-center transform for flash message appear/disappear.
- Anchoring the flash message to the pill's animated Y position, not a fixed coordinate.
- Mutual exclusion between tooltip and flash message in the draw pass.
- The full fireworks physics: gravity, exponential spark drag, deterministic spark angle distribution.
- Per-rocket colors from the `FIREWORK_COLORS` palette — trail, head, and sparks all share the rocket's color.
- Launch origin is the flash message banner center, not the pill.
- Render order: fireworks behind flash message, both on top of pill.
- Fireworks extend beyond the content area into the surrounding transparent window space.
