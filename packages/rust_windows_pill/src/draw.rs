use crate::constants::*;
use crate::gfx::Gfx;
use crate::ipc::{Phase, PillPermission, PillStreaming};
use crate::state::{ClickAction, ClickRegion, PillState, RocketPhase};

pub(crate) fn draw_all(gfx: &mut Gfx, state: &PillState) {
    gfx.begin_frame();
    gfx.clear();

    state.click_regions.borrow_mut().clear();

    let scale = state.ui_scale.get();
    gfx.save();
    gfx.scale(scale, scale);

    let ww = state.draw_width.get();
    let wh = state.draw_height.get();
    let (ox, oy) = state.content_offset();

    gfx.save();
    gfx.translate(ox, oy);

    if state.assistant_active.get() || state.panel_open_t.get() > 0.01 {
        draw_assistant_panel(gfx, state, ww, wh);
    } else if state.flash_t.get() < 0.01 {
        let pill_area_top = wh - PILL_AREA_HEIGHT;
        draw_tooltip(gfx, state, ww, pill_area_top);
    }

    if !state.assistant_active.get() && state.flame_active.get() {
        draw_flame(gfx, state, ww, wh);
    }

    draw_pill(gfx, state, ww, wh);

    if state.flash_blue_active.get() {
        draw_flash_blue(gfx, state, ww, wh);
    }

    if state.assistant_active.get() {
        draw_keyboard_button(gfx, state, ww, wh);
    }

    if !state.assistant_active.get() {
        if !state.fireworks_rockets.borrow().is_empty() {
            draw_fireworks(gfx, state);
        }

        if state.flash_t.get() > 0.01 {
            draw_flash_message(gfx, state, ww, wh);
        }

        if state.transcript_opacity.get() > 0.001 {
            draw_broadcast_transcript(gfx, state, ww, wh);
        }

        draw_cancel_button(gfx, state, ww, wh);
    }

    gfx.restore();
    gfx.restore();
    gfx.end_frame();
}

pub(crate) fn pill_position(state: &PillState, ww: f64, wh: f64) -> (f64, f64, f64, f64) {
    let expand_t = state.expand_t.get();
    let pill_w = lerp(MIN_PILL_WIDTH, EXPANDED_PILL_WIDTH, expand_t);
    let pill_h = lerp(MIN_PILL_HEIGHT, EXPANDED_PILL_HEIGHT, expand_t);
    let pill_x = (ww - pill_w) / 2.0;

    let pill_y = if state.assistant_active.get() || state.panel_open_t.get() > 0.01 {
        let panel_bottom = wh - PANEL_BOTTOM_MARGIN;
        panel_bottom - PILL_BOTTOM_INSET - pill_h
    } else {
        // Collapsed: hug the bottom (4px); expanded: rise to centered position
        let collapsed_bottom = 4.0;
        let expanded_bottom = (PILL_AREA_HEIGHT - EXPANDED_PILL_HEIGHT) / 2.0;
        let bottom_offset = lerp(collapsed_bottom, expanded_bottom, expand_t);
        wh - bottom_offset - pill_h
    };

    (pill_x, pill_y, pill_w, pill_h)
}

fn draw_pill(gfx: &mut Gfx, state: &PillState, ww: f64, wh: f64) {
    let expand_t = state.expand_t.get();
    let (rx, ry, pill_w, pill_h) = pill_position(state, ww, wh);

    let bg_alpha = lerp(IDLE_BG_ALPHA, ACTIVE_BG_ALPHA, expand_t);
    let radius = lerp(COLLAPSED_RADIUS, EXPANDED_RADIUS, expand_t);

    let is_typing = state.assistant_active.get()
        && *state.assistant_input_mode.borrow() == "type";
    if is_typing {
        return;
    }

    gfx.fill_rounded_rect(rx, ry, pill_w, pill_h, radius, [0.0, 0.0, 0.0, bg_alpha]);
    gfx.stroke_rounded_rect(rx + 0.5, ry + 0.5, pill_w - 1.0, pill_h - 1.0, radius - 0.5,
        [1.0, 1.0, 1.0, BORDER_ALPHA], 1.0);

    match state.phase.get() {
        Phase::Recording if expand_t > 0.1 => {
            draw_waveform(gfx, rx, ry, pill_w, pill_h, expand_t, state);
            draw_edge_gradient(gfx, rx, ry, pill_w, pill_h, expand_t);
        }
        Phase::Loading if expand_t > 0.1 => {
            draw_loading(gfx, rx, ry, pill_w, pill_h, expand_t, state);
        }
        Phase::Idle if expand_t > 0.5 && (state.hovered.get() || state.assistant_active.get()) => {
            draw_idle_label(gfx, rx, ry, pill_w, pill_h, expand_t);
        }
        _ => {}
    }

    state.click_regions.borrow_mut().push(ClickRegion {
        x: rx, y: ry, w: pill_w, h: pill_h,
        action: ClickAction::Pill,
    });
}

fn draw_waveform(
    gfx: &mut Gfx, rx: f64, ry: f64, pill_w: f64, pill_h: f64,
    expand_t: f64, state: &PillState,
) {
    let wave_phase = state.wave_phase.get();
    let level = state.current_level.get();
    let baseline = ry + pill_h / 2.0;

    gfx.save();
    gfx.clip_rounded_rect(rx, ry, pill_w, pill_h, pill_h / 2.0);

    for config in WAVE_CONFIGS {
        let amplitude_factor = (level * config.multiplier).clamp(MIN_AMPLITUDE, MAX_AMPLITUDE);
        let amplitude = (pill_h * 0.75 * amplitude_factor).max(1.0);
        let phase = wave_phase + config.phase_offset;
        let alpha = config.opacity * expand_t;
        let rgba = [1.0, 1.0, 1.0, alpha];

        let segments = (pill_w / 2.0).max(72.0) as i32;
        for i in 0..segments {
            let t0 = i as f64 / segments as f64;
            let t1 = (i + 1) as f64 / segments as f64;
            let x0 = rx + pill_w * t0;
            let x1 = rx + pill_w * t1;
            let theta0 = config.frequency * t0 * TAU + phase;
            let theta1 = config.frequency * t1 * TAU + phase;
            let y0 = baseline + amplitude * theta0.sin();
            let y1 = baseline + amplitude * theta1.sin();
            gfx.draw_line(x0, y0, x1, y1, rgba, STROKE_WIDTH);
        }
    }

    gfx.restore();
}

fn draw_edge_gradient(
    gfx: &mut Gfx, rx: f64, ry: f64, pill_w: f64, pill_h: f64, expand_t: f64,
) {
    let alpha = 0.9 * expand_t;

    gfx.save();
    gfx.clip_rounded_rect(rx, ry, pill_w, pill_h, lerp(COLLAPSED_RADIUS, EXPANDED_RADIUS, expand_t));

    gfx.fill_gradient_rect(
        rx, ry, pill_w * 0.18, pill_h,
        rx, 0.0, rx + pill_w * 0.18, 0.0,
        &[
            (0.0, [0.0, 0.0, 0.0, alpha]),
            (1.0, [0.0, 0.0, 0.0, 0.0]),
        ],
    );

    let right_start = rx + pill_w * 0.85;
    gfx.fill_gradient_rect(
        right_start, ry, pill_w * 0.15, pill_h,
        right_start, 0.0, rx + pill_w, 0.0,
        &[
            (0.0, [0.0, 0.0, 0.0, 0.0]),
            (1.0, [0.0, 0.0, 0.0, alpha]),
        ],
    );

    gfx.restore();
}

fn draw_loading(
    gfx: &mut Gfx, rx: f64, ry: f64, pill_w: f64, pill_h: f64,
    expand_t: f64, state: &PillState,
) {
    gfx.save();
    gfx.clip_rounded_rect(rx, ry, pill_w, pill_h, lerp(COLLAPSED_RADIUS, EXPANDED_RADIUS, expand_t));

    let bar_h = 2.0;
    let bar_y = ry + (pill_h - bar_h) / 2.0;
    let pad = pill_h * 0.1;
    let track_x = rx + pad;
    let track_w = pill_w - pad * 2.0;

    // Track line
    gfx.fill_rect(track_x, bar_y, track_w, bar_h, [1.0, 1.0, 1.0, 0.15 * expand_t]);

    // Moving indicator
    let indicator_w = track_w * LOADING_BAR_WIDTH_FRAC;
    let offset = state.loading_offset.get();
    let ind_x = track_x + (track_w + indicator_w) * offset - indicator_w;

    let draw_left = ind_x.max(track_x);
    let draw_right = (ind_x + indicator_w).min(track_x + track_w);
    if draw_right > draw_left {
        gfx.fill_rect(draw_left, bar_y, draw_right - draw_left, bar_h, [1.0, 1.0, 1.0, 0.7 * expand_t]);
    }

    gfx.restore();

    draw_edge_gradient(gfx, rx, ry, pill_w, pill_h, expand_t);
}

fn draw_idle_label(gfx: &Gfx, rx: f64, ry: f64, pill_w: f64, pill_h: f64, expand_t: f64) {
    gfx.draw_text_centered("Click to dictate", rx, ry, pill_w, pill_h,
        11.0, true, [1.0, 1.0, 1.0, 0.4 * expand_t]);
}

// ── Tooltip (dictation style selector) ────────────────────────────

fn draw_tooltip(gfx: &Gfx, state: &PillState, ww: f64, pill_area_top: f64) {
    let tooltip_t = state.tooltip_t.get();
    if tooltip_t < 0.01 { return; }

    let style_name = state.style_name.borrow();
    if state.style_count.get() <= 1 || style_name.is_empty() { return; }

    let tooltip_w = TOOLTIP_FIXED_WIDTH;
    state.tooltip_width.set(tooltip_w);

    let tooltip_rx = (ww - tooltip_w) / 2.0;
    let y_offset = (1.0 - tooltip_t) * 4.0;
    let tooltip_ry = pill_area_top - TOOLTIP_GAP - TOOLTIP_HEIGHT + y_offset;
    let alpha = tooltip_t;

    gfx.fill_rounded_rect(tooltip_rx, tooltip_ry, tooltip_w, TOOLTIP_HEIGHT, TOOLTIP_RADIUS,
        [0.0, 0.0, 0.0, 0.92 * alpha]);

    let center_y = tooltip_ry + TOOLTIP_HEIGHT / 2.0;
    let chevron_area = 28.0;
    let padding_h = 12.0;

    // Left chevron — clean, centered arrow
    let left_cx = tooltip_rx + padding_h + 6.0;
    let ca = [1.0, 1.0, 1.0, 0.7 * alpha];
    gfx.draw_line(left_cx + 3.0, center_y - 5.0, left_cx - 2.0, center_y, ca, 1.5);
    gfx.draw_line(left_cx - 2.0, center_y, left_cx + 3.0, center_y + 5.0, ca, 1.5);

    // Right chevron
    let right_cx = tooltip_rx + tooltip_w - padding_h - 6.0;
    gfx.draw_line(right_cx - 3.0, center_y - 5.0, right_cx + 2.0, center_y, ca, 1.5);
    gfx.draw_line(right_cx + 2.0, center_y, right_cx - 3.0, center_y + 5.0, ca, 1.5);

    // Style name text — larger font, centered in remaining area
    let text_area_left = tooltip_rx + padding_h + chevron_area;
    let text_area_right = tooltip_rx + tooltip_w - padding_h - chevron_area;
    let text_area_w = text_area_right - text_area_left;
    gfx.draw_text_centered(&style_name, text_area_left, tooltip_ry, text_area_w, TOOLTIP_HEIGHT,
        12.0, true, [1.0, 1.0, 1.0, 0.9 * alpha]);

    // Click regions
    let mid_x = tooltip_rx + tooltip_w / 2.0;
    state.click_regions.borrow_mut().push(ClickRegion {
        x: tooltip_rx, y: tooltip_ry, w: mid_x - tooltip_rx, h: TOOLTIP_HEIGHT,
        action: ClickAction::StyleBackward,
    });
    state.click_regions.borrow_mut().push(ClickRegion {
        x: mid_x, y: tooltip_ry, w: tooltip_rx + tooltip_w - mid_x, h: TOOLTIP_HEIGHT,
        action: ClickAction::StyleForward,
    });
}

// ── Flash message ────────────────────────────────────────────────

fn draw_flash_message(gfx: &mut Gfx, state: &PillState, ww: f64, wh: f64) {
    let flash_t = state.flash_t.get();
    if flash_t < 0.01 { return; }

    let message = state.flash_message.borrow();
    if message.is_empty() { return; }

    let is_error = state.flash_is_error.get();
    let action_label = state.flash_action_label.borrow();
    let has_action = action_label.is_some();

    let (text_w, _) = gfx.measure_text(&message, 12.0, true);

    let action_w = if let Some(ref label) = *action_label {
        let (aw, _) = gfx.measure_text(label, 11.0, true);
        aw + FLASH_ACTION_PADDING_H * 2.0
    } else {
        0.0
    };
    let action_section = if has_action { FLASH_ACTION_GAP + action_w } else { 0.0 };

    let flash_w = (text_w + FLASH_PADDING_H * 2.0 + action_section).max(80.0);

    let scale = FLASH_MIN_SCALE + (1.0 - FLASH_MIN_SCALE) * flash_t;
    let alpha = flash_t;

    let (_, pill_y, _, _) = pill_position(state, ww, wh);
    let full_x = (ww - flash_w) / 2.0;
    let full_y = pill_y - FLASH_GAP - FLASH_HEIGHT;

    let center_x = full_x + flash_w / 2.0;
    let center_y = full_y + FLASH_HEIGHT / 2.0;

    gfx.save();
    gfx.translate(center_x, center_y);
    gfx.scale(scale, scale);
    gfx.translate(-center_x, -center_y);

    // Background
    let (bg_r, bg_g, bg_b) = if is_error { (0.35, 0.05, 0.05) } else { (0.0, 0.0, 0.0) };
    gfx.fill_rounded_rect(full_x, full_y, flash_w, FLASH_HEIGHT, FLASH_RADIUS,
        [bg_r, bg_g, bg_b, 0.92 * alpha]);

    // Message text
    if has_action {
        let (_, th) = gfx.measure_text(&message, 12.0, true);
        gfx.draw_text_top_left(&message, full_x + FLASH_PADDING_H,
            full_y + (FLASH_HEIGHT - th) / 2.0,
            12.0, true, false, [1.0, 1.0, 1.0, 0.9 * alpha]);
    } else {
        gfx.draw_text_centered(&message, full_x, full_y, flash_w, FLASH_HEIGHT,
            12.0, true, [1.0, 1.0, 1.0, 0.9 * alpha]);
    }

    // Action button
    if let Some(ref label) = *action_label {
        let btn_x = full_x + flash_w - FLASH_PADDING_H - action_w;
        let btn_y = full_y + (FLASH_HEIGHT - FLASH_ACTION_HEIGHT) / 2.0;

        gfx.fill_rounded_rect(btn_x, btn_y, action_w, FLASH_ACTION_HEIGHT, FLASH_ACTION_RADIUS,
            [1.0, 1.0, 1.0, 0.2 * alpha]);

        gfx.draw_text_centered(label, btn_x, btn_y, action_w, FLASH_ACTION_HEIGHT,
            11.0, true, [1.0, 1.0, 1.0, 0.95 * alpha]);

        state.click_regions.borrow_mut().push(ClickRegion {
            x: btn_x,
            y: btn_y,
            w: action_w,
            h: FLASH_ACTION_HEIGHT,
            action: ClickAction::FlashAction,
        });
    }

    gfx.restore();
}

// ── Flame ────────────────────────────────────────────────────────

fn draw_flame(gfx: &Gfx, state: &PillState, ww: f64, wh: f64) {
    let elapsed = state.flame_elapsed.get();
    let tongues = state.flame_tongues.borrow();
    if tongues.is_empty() {
        return;
    }

    let (pill_x, pill_y, pill_w, pill_h) = pill_position(state, ww, wh);
    let base_y = pill_y + pill_h * 0.35;
    let inset = pill_w * 0.12;
    let usable = pill_w - inset * 2.0;

    let fade_in = (elapsed / 0.3).clamp(0.0, 1.0);
    let fade_out = ((FLAME_TOTAL_DURATION - elapsed) / 0.8).clamp(0.0, 1.0);
    let alpha = fade_in * fade_out;
    if alpha < 0.01 {
        return;
    }

    for tongue in tongues.iter() {
        let flicker = (tongue.phase.sin() * 0.5 + 0.5) * 0.25 + 0.75;
        let flicker2 = ((tongue.phase * 1.6 + 0.8).sin() * 0.5 + 0.5) * 0.15 + 0.85;
        let h = tongue.height * flicker * flicker2;
        let w = tongue.width * (0.85 + 0.15 * flicker);
        let hw = w / 2.0;

        let sway = tongue.phase.sin() * FLAME_SWAY
            + (tongue.phase * 1.7 + 1.0).sin() * FLAME_SWAY * 0.4;

        let base_x = pill_x + inset + usable * tongue.t;
        let cx = base_x + sway * 0.3;

        // Layer 1: outer glow — wide, soft, dim
        gfx.fill_flame_tongue(cx, base_y, h * 1.2, hw * 1.5, sway * 1.1,
            &[
                (0.0, 0.7, 0.7, 0.7, alpha * 0.15),
                (0.4, 0.4, 0.4, 0.4, alpha * 0.08),
                (1.0, 0.0, 0.0, 0.0, 0.0),
            ],
        );

        // Layer 2: main flame body
        gfx.fill_flame_tongue(cx, base_y, h, hw, sway,
            &[
                (0.0, 1.0, 1.0, 1.0, alpha * 0.85),
                (0.25, 1.0, 1.0, 1.0, alpha * 0.65),
                (0.55, 0.8, 0.8, 0.8, alpha * 0.3),
                (1.0, 0.0, 0.0, 0.0, 0.0),
            ],
        );

        // Layer 3: inner bright core — narrow, hot white
        gfx.fill_flame_tongue(cx, base_y, h * 0.55, hw * 0.35, sway * 0.5,
            &[
                (0.0, 1.0, 1.0, 1.0, alpha * 0.95),
                (0.5, 1.0, 1.0, 1.0, alpha * 0.5),
                (1.0, 1.0, 1.0, 1.0, 0.0),
            ],
        );
    }
}

// ── Flash blue border ────────────────────────────────────────────

fn draw_flash_blue(gfx: &mut Gfx, state: &PillState, ww: f64, wh: f64) {
    let elapsed = state.flash_blue_elapsed.get();
    if elapsed <= 0.0 || elapsed >= FLASH_BLUE_DURATION {
        return;
    }
    let t = elapsed / FLASH_BLUE_DURATION;
    let alpha = (t * std::f64::consts::PI).sin().max(0.0);
    if alpha < 0.01 {
        return;
    }

    let (px, py, pw, ph) = pill_position(state, ww, wh);
    let inset = -FLASH_BLUE_INSET;
    let rx = px + inset;
    let ry = py + inset;
    let rw = pw - inset * 2.0;
    let rh = ph - inset * 2.0;

    let expand_t = state.expand_t.get();
    let radius = lerp(COLLAPSED_RADIUS, EXPANDED_RADIUS, expand_t) + FLASH_BLUE_INSET;

    let (gr, gg, gb) = FLASH_BLUE_GLOW_COLOR;
    gfx.stroke_rounded_rect(
        rx - 1.5, ry - 1.5, rw + 3.0, rh + 3.0, radius + 1.5,
        [gr, gg, gb, 0.35 * alpha],
        FLASH_BLUE_BORDER_WIDTH + 2.0,
    );

    let (r, g, b) = FLASH_BLUE_COLOR;
    gfx.stroke_rounded_rect(
        rx, ry, rw, rh, radius,
        [r, g, b, alpha],
        FLASH_BLUE_BORDER_WIDTH,
    );
}

// ── Broadcast transcript ─────────────────────────────────────────

fn draw_broadcast_transcript(gfx: &mut Gfx, state: &PillState, ww: f64, wh: f64) {
    let alpha = state.transcript_opacity.get();
    if alpha < 0.01 {
        return;
    }
    let text = state.transcript_text.borrow();
    if text.is_empty() {
        return;
    }

    let (text_w, _) = gfx.measure_text(&text, TRANSCRIPT_FONT_SIZE, false);
    let box_w = (text_w + TRANSCRIPT_PADDING_H * 2.0).min(TRANSCRIPT_MAX_WIDTH);

    let (_, pill_y, _, _) = pill_position(state, ww, wh);
    let box_x = (ww - box_w) / 2.0;
    let rise = (1.0 - alpha) * 6.0;
    let box_y = pill_y - TRANSCRIPT_GAP - TRANSCRIPT_HEIGHT + rise;

    gfx.fill_rounded_rect(
        box_x, box_y, box_w, TRANSCRIPT_HEIGHT, TRANSCRIPT_RADIUS,
        [0.0, 0.0, 0.0, alpha],
    );
    gfx.stroke_rounded_rect(
        box_x + 0.5, box_y + 0.5, box_w - 1.0, TRANSCRIPT_HEIGHT - 1.0, TRANSCRIPT_RADIUS - 0.5,
        [0.45, 0.75, 1.0, 0.35 * alpha],
        1.0,
    );

    gfx.draw_text_centered(
        &text, box_x, box_y, box_w, TRANSCRIPT_HEIGHT,
        TRANSCRIPT_FONT_SIZE, false,
        [1.0, 1.0, 1.0, 0.95 * alpha],
    );
}

// ── Fireworks ────────────────────────────────────────────────────

fn draw_fireworks(gfx: &Gfx, state: &PillState) {
    let rockets = state.fireworks_rockets.borrow();

    for rocket in rockets.iter() {
        let (rc, gc, bc) = rocket.color;

        if rocket.trail.len() > 1 && rocket.trail_alpha > 0.01 {
            let n = rocket.trail.len();
            for i in 1..n {
                let alpha = (i as f64 / n as f64) * rocket.trail_alpha * 0.8;
                gfx.draw_line(
                    rocket.trail[i - 1].0, rocket.trail[i - 1].1,
                    rocket.trail[i].0, rocket.trail[i].1,
                    [rc, gc, bc, alpha], FIREWORKS_ROCKET_LINE_WIDTH,
                );
            }
        }

        if rocket.phase == RocketPhase::Rising {
            let hs = FIREWORKS_HEAD_SIZE / 2.0;
            gfx.fill_rounded_rect(
                rocket.x - hs, rocket.y - hs,
                FIREWORKS_HEAD_SIZE, FIREWORKS_HEAD_SIZE, hs,
                [rc, gc, bc, 0.95],
            );
        }

        for spark in &rocket.sparks {
            if spark.life <= 0.0 { continue; }
            let alpha = spark.life.clamp(0.0, 1.0) * 0.9;
            let speed = (spark.vx * spark.vx + spark.vy * spark.vy).sqrt();
            let line_len = (speed * 0.04).clamp(2.0, 10.0);
            let (nx, ny) = if speed > 0.01 {
                (spark.vx / speed, spark.vy / speed)
            } else {
                (0.0, -1.0)
            };
            gfx.draw_line(
                spark.x - nx * line_len, spark.y - ny * line_len,
                spark.x, spark.y,
                [rc, gc, bc, alpha], FIREWORKS_SPARK_LINE_WIDTH,
            );
        }
    }
}

// ── Assistant panel ───────────────────────────────────────────────

fn draw_assistant_panel(gfx: &mut Gfx, state: &PillState, ww: f64, wh: f64) {
    let panel_t = state.panel_open_t.get();
    if panel_t < 0.01 { return; }

    let is_compact = state.assistant_compact.get();
    let is_typing = *state.assistant_input_mode.borrow() == "type";

    let panel_w = if is_compact { PANEL_COMPACT_WIDTH } else { PANEL_EXPANDED_WIDTH };
    let panel_x = (ww - panel_w) / 2.0;
    let panel_y = PANEL_TOP_MARGIN;
    let panel_h = wh - PANEL_TOP_MARGIN - PANEL_BOTTOM_MARGIN;

    let alpha = panel_t;
    let y_shift = (1.0 - panel_t) * 12.0;

    gfx.fill_rounded_rect(panel_x, panel_y + y_shift, panel_w, panel_h, PANEL_RADIUS,
        [0.0, 0.0, 0.0, PANEL_BG_ALPHA * alpha]);
    gfx.stroke_rounded_rect(panel_x + 0.5, panel_y + y_shift + 0.5, panel_w - 1.0, panel_h - 1.0,
        PANEL_RADIUS - 0.5, [1.0, 1.0, 1.0, PANEL_BORDER_ALPHA * alpha], 1.0);

    let py = panel_y + y_shift;
    let pill_top_in_panel = panel_h - PILL_BOTTOM_INSET - EXPANDED_PILL_HEIGHT;

    if is_compact {
        draw_compact_content(gfx, panel_x, py, panel_w, pill_top_in_panel, alpha, state);
    } else {
        gfx.save();
        gfx.clip_rounded_rect(panel_x, py, panel_w, panel_h, PANEL_RADIUS);

        let content_x = panel_x + PANEL_CONTENT_SIDE_INSET;
        let content_w = panel_w - PANEL_CONTENT_SIDE_INSET * 2.0;

        let scroll_bottom = if is_typing { py + panel_h - PANEL_INPUT_HEIGHT } else { py + panel_h };
        let scroll_h = (scroll_bottom - py).max(0.0);
        state.viewport_height.set(scroll_h);

        let top_pad = PANEL_TRANSCRIPT_TOP_OFFSET + SCROLL_TOP_PAD;
        let bottom_pad = if is_typing {
            SCROLL_BOTTOM_PAD
        } else {
            PILL_BOTTOM_INSET + EXPANDED_PILL_HEIGHT + SCROLL_BOTTOM_PAD
        };

        draw_transcript(gfx, state, content_x, py, content_w, scroll_h, alpha, top_pad, bottom_pad);

        // Top gradient
        let grad_h = PANEL_TRANSCRIPT_TOP_OFFSET + 16.0;
        gfx.fill_gradient_rect(
            panel_x, py, panel_w, grad_h,
            0.0, py, 0.0, py + grad_h,
            &[
                (0.0, [0.0, 0.0, 0.0, 0.98 * alpha]),
                (0.38, [0.0, 0.0, 0.0, 0.82 * alpha]),
                (1.0, [0.0, 0.0, 0.0, 0.0]),
            ],
        );

        // Bottom gradient
        let bot_area = if is_typing { 0.0 } else { PILL_BOTTOM_INSET + EXPANDED_PILL_HEIGHT };
        let bot_grad_h = bot_area + 16.0;
        let bot_y = scroll_bottom - bot_grad_h;
        gfx.fill_gradient_rect(
            panel_x, bot_y, panel_w, bot_grad_h,
            0.0, bot_y, 0.0, scroll_bottom,
            &[
                (0.0, [0.0, 0.0, 0.0, 0.0]),
                (0.28, [0.0, 0.0, 0.0, 0.82 * alpha]),
                (1.0, [0.0, 0.0, 0.0, 0.98 * alpha]),
            ],
        );

        gfx.restore();

        // Header elements on top of gradients
        if let Some(ref prompt) = *state.assistant_user_prompt.borrow() {
            draw_user_prompt_preview(gfx, panel_x, py, panel_w, prompt, alpha);
        }

        let open_x = panel_x + PANEL_HEADER_OFFSET_LEFT + HEADER_BUTTON_SIZE + 4.0;
        let open_y = py + PANEL_HEADER_OFFSET_TOP;
        let open_hovered = is_mouse_over(state, open_x, open_y, HEADER_BUTTON_SIZE, HEADER_BUTTON_SIZE);
        draw_panel_button(gfx, open_x, open_y, HEADER_BUTTON_SIZE, alpha, ButtonIcon::OpenInNew, open_hovered);
        state.click_regions.borrow_mut().push(ClickRegion {
            x: open_x, y: open_y,
            w: HEADER_BUTTON_SIZE, h: HEADER_BUTTON_SIZE,
            action: ClickAction::OpenInNew,
        });

        // Input bar
        if is_typing {
            let input_y = py + panel_h - PANEL_INPUT_HEIGHT;
            gfx.draw_line(
                panel_x + PANEL_CONTENT_SIDE_INSET, input_y,
                panel_x + panel_w - PANEL_CONTENT_SIDE_INSET, input_y,
                [1.0, 1.0, 1.0, 0.1 * alpha], 1.0,
            );

            // Send button
            let send_btn_size = 28.0;
            let send_x = panel_x + panel_w - PANEL_CONTENT_SIDE_INSET - send_btn_size;
            let send_y = input_y + (PANEL_INPUT_HEIGHT - send_btn_size) / 2.0;
            let has_text = !state.entry_text.borrow().trim().is_empty();
            let send_hovered = has_text && is_mouse_over(state, send_x, send_y, send_btn_size, send_btn_size);
            let text_alpha = if send_hovered { 1.0 } else if has_text { 0.82 } else { 0.2 };
            let ca = [1.0, 1.0, 1.0, text_alpha * alpha];

            let cx = send_x + send_btn_size / 2.0;
            let cy = send_y + send_btn_size / 2.0;
            // Filled circle with up arrow (like arrow.up.circle.fill)
            gfx.fill_circle(cx, cy, 9.0, ca);
            let arrow_color = [0.0, 0.0, 0.0, 0.9];
            gfx.draw_line(cx, cy + 3.5, cx, cy - 3.5, arrow_color, 1.8);
            gfx.draw_line(cx - 3.0, cy - 1.0, cx, cy - 4.0, arrow_color, 1.8);
            gfx.draw_line(cx + 3.0, cy - 1.0, cx, cy - 4.0, arrow_color, 1.8);

            // Text input area — native Edit control overlays this region
            let input_x = panel_x + PANEL_CONTENT_SIDE_INSET;
            let input_w = panel_w - PANEL_CONTENT_SIDE_INSET * 2.0 - send_btn_size - 8.0;

            // Click region for cursor (IDC_IBEAM) and focus
            state.click_regions.borrow_mut().push(ClickRegion {
                x: input_x, y: input_y + 1.0, w: input_w, h: PANEL_INPUT_HEIGHT - 1.0,
                action: ClickAction::InputField,
            });

            if has_text {
                state.click_regions.borrow_mut().push(ClickRegion {
                    x: send_x, y: send_y, w: send_btn_size, h: send_btn_size,
                    action: ClickAction::SendButton,
                });
            }
        }
    }

    // Close button
    let close_x = panel_x + PANEL_HEADER_OFFSET_LEFT;
    let close_y = py + PANEL_HEADER_OFFSET_TOP;
    let close_hovered = is_mouse_over(state, close_x, close_y, HEADER_BUTTON_SIZE, HEADER_BUTTON_SIZE);
    draw_panel_button(gfx, close_x, close_y, HEADER_BUTTON_SIZE, alpha, ButtonIcon::Close, close_hovered);
    state.click_regions.borrow_mut().push(ClickRegion {
        x: close_x, y: close_y,
        w: HEADER_BUTTON_SIZE, h: HEADER_BUTTON_SIZE,
        action: ClickAction::AssistantClose,
    });
}

fn draw_compact_content(
    gfx: &Gfx, panel_x: f64, panel_y: f64, panel_w: f64,
    content_height: f64, alpha: f64, state: &PillState,
) {
    let text = "What can I help you with?";
    let text_alpha = if state.phase.get() == Phase::Recording { 0.96 } else { 0.8 };
    gfx.draw_text_centered(text, panel_x, panel_y, panel_w, content_height,
        18.0, false, [1.0, 1.0, 1.0, text_alpha * alpha]);
}

fn draw_transcript(
    gfx: &mut Gfx, state: &PillState,
    area_x: f64, area_y: f64, area_w: f64, area_h: f64, alpha: f64,
    top_pad: f64, bottom_pad: f64,
) {
    let messages = state.assistant_messages.borrow();
    let streaming = state.assistant_streaming.borrow();
    let permissions = state.assistant_permissions.borrow();

    if messages.is_empty() && permissions.is_empty() { return; }

    gfx.save();
    gfx.clip_rect(area_x, area_y, area_w, area_h);

    let scroll = state.scroll_offset.get();
    let mut y = area_y + top_pad - scroll;

    let line_height = 20.0;

    for (i, msg) in messages.iter().enumerate() {
        if i > 0 {
            y += 16.0;
            gfx.draw_line(area_x, y, area_x + 36.0, y, [1.0, 1.0, 1.0, 0.45 * alpha], 1.0);
            y += 8.0;
        }

        if let Some(ref stream) = *streaming {
            if stream.message_id == msg.id {
                y = draw_streaming_activity(gfx, stream, area_x, y, alpha);
            }
        }

        if msg.is_tool_result {
            let tool_desc = msg.tool_description.as_deref()
                .or(msg.tool_name.as_deref())
                .unwrap_or("Tool");
            let reason = msg.reason.as_deref().unwrap_or("");
            let display = if reason.is_empty() {
                tool_desc.to_string()
            } else {
                format!("{tool_desc} — {reason}")
            };

            draw_wrench_icon(gfx, area_x, y + 2.0, 12.0, 0.5 * alpha);
            gfx.draw_text_top_left(&display, area_x + 18.0, y,
                12.0, false, false, [1.0, 1.0, 1.0, 0.5 * alpha]);
            y += 18.0;
        } else if let Some(ref content) = msg.content {
            let (r, g, b) = if msg.is_error { (1.0, 0.4, 0.4) } else { (1.0, 1.0, 1.0) };
            let color_alpha = if msg.is_error { 0.94 } else { 0.92 };

            let lines = wrap_text(gfx, content, area_w);
            for line in &lines {
                gfx.draw_text_top_left(line, area_x, y,
                    14.0, false, false, [r, g, b, color_alpha * alpha]);
                y += line_height;
            }
        } else {
            y = draw_thinking_text(gfx, area_x, y, alpha, state);
        }
    }

    for perm in permissions.iter() {
        y += 12.0;
        y = draw_permission_card(gfx, state, perm, area_x, y, area_w, alpha);
    }

    let total_height = y + scroll - area_y + bottom_pad;
    state.content_height.set(total_height);

    gfx.restore();
}

fn draw_streaming_activity(
    gfx: &Gfx, streaming: &PillStreaming,
    x: f64, mut y: f64, alpha: f64,
) -> f64 {
    for tc in &streaming.tool_calls {
        let text = if tc.done {
            format!("Used {}", tc.name)
        } else {
            format!("Using {}…", tc.name)
        };
        gfx.draw_text_top_left(&text, x, y, 12.0, false, true, [1.0, 1.0, 1.0, 0.5 * alpha]);
        y += 16.0;
    }

    if !streaming.reasoning.is_empty() {
        let label = if streaming.is_streaming { "Thinking…" } else { "Thought process" };
        gfx.draw_text_top_left(label, x, y, 12.0, false, true, [1.0, 1.0, 1.0, 0.5 * alpha]);
        y += 16.0;
    }

    y
}

fn draw_thinking_text(
    gfx: &Gfx, x: f64, y: f64, alpha: f64, state: &PillState,
) -> f64 {
    let text = "Thinking";
    let (full_width, _) = gfx.measure_text(text, 14.0, false);

    let shimmer = state.shimmer_phase.get();
    let grad_center = shimmer * 4.0 - 1.0; // sweeps from -1 to 3

    // Per-character shimmer — each char gets its own alpha based on distance
    // from the shimmer center, matching the macOS pill
    let mut char_x = x;
    for ch in text.chars() {
        let ch_str = ch.to_string();
        let (ch_w, _) = gfx.measure_text(&ch_str, 14.0, false);
        let pos = if full_width > 0.0 { (char_x - x) / full_width } else { 0.0 };
        let dist = (pos - grad_center).abs();
        let ch_alpha = lerp(0.92, 0.34, (dist * 2.0).clamp(0.0, 1.0));

        gfx.draw_text_top_left(&ch_str, char_x, y, 14.0, false, false,
            [1.0, 1.0, 1.0, ch_alpha * alpha]);
        char_x += ch_w;
    }

    y + 20.0
}

fn draw_permission_card(
    gfx: &Gfx, state: &PillState, perm: &PillPermission,
    x: f64, y: f64, w: f64, alpha: f64,
) -> f64 {
    let card_h = PERM_CARD_HEIGHT;

    gfx.fill_rounded_rect(x, y, w, card_h, 12.0, [1.0, 1.0, 1.0, 0.06 * alpha]);
    gfx.stroke_rounded_rect(x + 0.5, y + 0.5, w - 1.0, card_h - 1.0, 11.5,
        [1.0, 1.0, 1.0, 0.12 * alpha], 1.0);

    let tool_label = perm.description.as_deref().unwrap_or(&perm.tool_name);
    gfx.draw_text_top_left(tool_label, x + 12.0, y + 6.0, 12.0, true, false,
        [1.0, 1.0, 1.0, 0.82 * alpha]);

    if let Some(ref reason) = perm.reason {
        gfx.draw_text_top_left(reason, x + 12.0, y + 22.0, 11.0, false, false,
            [1.0, 1.0, 1.0, 0.5 * alpha]);
    }

    let btn_y = y + card_h - PERM_BUTTON_HEIGHT - 8.0;
    let btn_labels = [("Deny", 0.5), ("Allow", 0.82), ("Always Allow", 0.82)];
    let mut btn_x = x + w - 12.0;

    for (i, (label, text_alpha)) in btn_labels.iter().rev().enumerate() {
        let btn_w = if i == 0 { PERM_BUTTON_WIDTH + 16.0 } else { PERM_BUTTON_WIDTH };
        btn_x -= btn_w;

        let hovered = is_mouse_over(state, btn_x, btn_y, btn_w, PERM_BUTTON_HEIGHT);
        let bg_alpha = if hovered { 0.18 } else { 0.08 };
        let border_alpha = if hovered { 0.25 } else { 0.15 };
        gfx.fill_rounded_rect(btn_x, btn_y, btn_w, PERM_BUTTON_HEIGHT, 6.0,
            [1.0, 1.0, 1.0, bg_alpha * alpha]);
        gfx.stroke_rounded_rect(btn_x + 0.5, btn_y + 0.5, btn_w - 1.0, PERM_BUTTON_HEIGHT - 1.0, 5.5,
            [1.0, 1.0, 1.0, border_alpha * alpha], 1.0);

        let text_a = if hovered { 1.0 } else { *text_alpha };
        gfx.draw_text_centered(label, btn_x, btn_y, btn_w, PERM_BUTTON_HEIGHT,
            11.0, false, [1.0, 1.0, 1.0, text_a * alpha]);

        let action = match 2 - i {
            0 => ClickAction::PermissionDeny(perm.id.clone()),
            1 => ClickAction::PermissionAllow(perm.id.clone()),
            _ => ClickAction::PermissionAlwaysAllow(perm.id.clone()),
        };
        state.click_regions.borrow_mut().push(ClickRegion {
            x: btn_x, y: btn_y, w: btn_w, h: PERM_BUTTON_HEIGHT, action,
        });

        btn_x -= PERM_BUTTON_GAP;
    }

    y + card_h
}

fn draw_user_prompt_preview(
    gfx: &Gfx, panel_x: f64, panel_y: f64, panel_w: f64,
    prompt: &str, alpha: f64,
) {
    let max_w = panel_w * 0.5;
    let mut display = prompt.to_string();
    loop {
        let (tw, _) = gfx.measure_text(&display, 14.0, false);
        if tw <= max_w || display.len() < 4 { break; }
        display.truncate(display.len() - 4);
        display.push('…');
    }

    let (tw, th) = gfx.measure_text(&display, 14.0, false);
    let tx = panel_x + panel_w - PANEL_HEADER_OFFSET_RIGHT - tw;
    let ty = panel_y + PANEL_HEADER_OFFSET_TOP + (HEADER_BUTTON_SIZE - th) / 2.0;
    gfx.draw_text_top_left(&display, tx, ty, 14.0, false, false, [1.0, 1.0, 1.0, 0.5 * alpha]);
}

#[derive(Debug, Clone, Copy)]
enum ButtonIcon {
    Close,
    OpenInNew,
}

fn draw_panel_button(gfx: &Gfx, x: f64, y: f64, size: f64, alpha: f64, icon: ButtonIcon, hovered: bool) {
    let bg_alpha = if hovered { 0.16 } else { 0.06 };
    gfx.fill_rounded_rect(x, y, size, size, size / 4.0, [1.0, 1.0, 1.0, bg_alpha * alpha]);

    let cx = x + size / 2.0;
    let cy = y + size / 2.0;
    let ca = [1.0, 1.0, 1.0, 0.82 * alpha];

    match icon {
        ButtonIcon::Close => {
            // Thicker, bolder X like macOS xmark
            let s = 4.5;
            gfx.draw_line(cx - s, cy - s, cx + s, cy + s, ca, 1.8);
            gfx.draw_line(cx + s, cy - s, cx - s, cy + s, ca, 1.8);
        }
        ButtonIcon::OpenInNew => {
            // Arrow going up-right out of a rounded rect (like arrow.up.forward.app)
            let s = 4.5;
            // Diagonal arrow
            gfx.draw_line(cx - 1.0, cy + 1.0, cx + s, cy - s, ca, 1.5);
            // Arrowhead
            gfx.draw_line(cx + s - 3.5, cy - s, cx + s, cy - s, ca, 1.5);
            gfx.draw_line(cx + s, cy - s, cx + s, cy - s + 3.5, ca, 1.5);
            // Rounded rect base
            gfx.draw_line(cx - s, cy - 1.5, cx - s, cy + s, ca, 1.3);
            gfx.draw_line(cx - s, cy + s, cx + 1.5, cy + s, ca, 1.3);
        }
    }
}

fn draw_keyboard_button(gfx: &mut Gfx, state: &PillState, ww: f64, wh: f64) {
    let kb_t = state.kb_button_t.get();
    if kb_t < 0.01 { return; }

    let (_, pill_y, _, _) = pill_position(state, ww, wh);
    let pill_center_x = ww / 2.0;

    let target_x = pill_center_x + EXPANDED_PILL_WIDTH / 2.0 + KB_BUTTON_GAP;
    let hidden_x = pill_center_x - KB_BUTTON_SIZE / 2.0;
    let btn_x = lerp(hidden_x, target_x, kb_t);
    let btn_y = pill_y + (EXPANDED_PILL_HEIGHT - KB_BUTTON_SIZE) / 2.0;
    let scale = lerp(0.5, 1.0, kb_t);
    let alpha = kb_t;

    gfx.save();
    gfx.translate(btn_x + KB_BUTTON_SIZE / 2.0, btn_y + KB_BUTTON_SIZE / 2.0);
    gfx.scale(scale, scale);
    gfx.translate(-(KB_BUTTON_SIZE / 2.0), -(KB_BUTTON_SIZE / 2.0));

    let kb_hovered = is_mouse_over(state, btn_x, btn_y, KB_BUTTON_SIZE, KB_BUTTON_SIZE);
    let kb_bg = if kb_hovered { 1.0 } else { 0.92 };
    let kb_border = if kb_hovered { 0.5 } else { BORDER_ALPHA };
    gfx.fill_circle(KB_BUTTON_SIZE / 2.0, KB_BUTTON_SIZE / 2.0, KB_BUTTON_SIZE / 2.0,
        [0.0, 0.0, 0.0, kb_bg * alpha]);
    gfx.stroke_circle(KB_BUTTON_SIZE / 2.0, KB_BUTTON_SIZE / 2.0, KB_BUTTON_SIZE / 2.0 - 0.5,
        [1.0, 1.0, 1.0, kb_border * alpha], 1.0);

    let cx = KB_BUTTON_SIZE / 2.0;
    let cy = KB_BUTTON_SIZE / 2.0;
    let kw = 12.0;
    let kh = 8.0;
    let kx = cx - kw / 2.0;
    let ky = cy - kh / 2.0;

    let ka = [1.0, 1.0, 1.0, 0.7 * alpha];
    gfx.stroke_rounded_rect(kx, ky, kw, kh, 2.0, ka, 1.0);

    // Row 1: three key rectangles
    for d in 0..3 {
        let key_x = kx + 2.0 + d as f64 * 3.2;
        gfx.fill_rounded_rect(key_x, ky + 1.8, 2.0, 1.6, 0.4, ka);
    }
    // Row 2: two key rectangles
    for d in 0..2 {
        let key_x = kx + 3.5 + d as f64 * 3.2;
        gfx.fill_rounded_rect(key_x, ky + 4.6, 2.0, 1.6, 0.4, ka);
    }

    gfx.restore();

    if kb_t > 0.5 {
        state.click_regions.borrow_mut().push(ClickRegion {
            x: btn_x, y: btn_y, w: KB_BUTTON_SIZE, h: KB_BUTTON_SIZE,
            action: ClickAction::KeyboardButton,
        });
    }
}

fn draw_cancel_button(gfx: &Gfx, state: &PillState, ww: f64, wh: f64) {
    let t = state.cancel_t.get();
    if t < 0.01 { return; }

    let (pill_x, pill_y, pill_w, _) = pill_position(state, ww, wh);
    let btn_x = pill_x + pill_w - CANCEL_BUTTON_SIZE / 2.0 + 2.0;
    let btn_y = pill_y - CANCEL_BUTTON_SIZE / 2.0 - 2.0;
    let cx = btn_x + CANCEL_BUTTON_SIZE / 2.0;
    let cy = btn_y + CANCEL_BUTTON_SIZE / 2.0;
    let r = (CANCEL_BUTTON_SIZE - 2.0) / 2.0;

    let scale = 0.5 + 0.5 * t;
    let cancel_hovered = is_mouse_over(state, btn_x, btn_y, CANCEL_BUTTON_SIZE, CANCEL_BUTTON_SIZE);
    let cancel_brightness = if cancel_hovered { 0.6 } else { 0.46 };

    // Note: Windows Gfx doesn't have save/restore with transforms the same way,
    // so we scale the radius and position offsets directly
    let sr = r * scale;
    gfx.fill_circle(cx, cy, sr, [cancel_brightness, cancel_brightness, cancel_brightness, t]);

    let s = 3.0 * scale;
    gfx.draw_line(cx - s, cy - s, cx + s, cy + s, [1.0, 1.0, 1.0, t], 1.8);
    gfx.draw_line(cx + s, cy - s, cx - s, cy + s, [1.0, 1.0, 1.0, t], 1.8);

    if t > 0.5 {
        state.click_regions.borrow_mut().push(ClickRegion {
            x: btn_x, y: btn_y, w: CANCEL_BUTTON_SIZE, h: CANCEL_BUTTON_SIZE,
            action: ClickAction::CancelDictation,
        });
    }
}

fn draw_wrench_icon(gfx: &Gfx, x: f64, y: f64, size: f64, alpha: f64) {
    let ca = [1.0, 1.0, 1.0, alpha];
    let cx = x + size / 2.0;
    let cy = y + size / 2.0;
    // Wrench: circle head + angled handle
    let r = size * 0.28;
    gfx.stroke_circle(cx - r * 0.3, cy - r * 0.3, r, ca, 1.2);
    gfx.draw_line(cx + r * 0.3, cy + r * 0.3, cx + size * 0.42, cy + size * 0.42, ca, 1.2);
}

// ── Text wrapping ─────────────────────────────────────────────────

fn wrap_text(gfx: &Gfx, text: &str, max_width: f64) -> Vec<String> {
    let mut lines = Vec::new();
    for paragraph in text.split('\n') {
        let words: Vec<&str> = paragraph.split_whitespace().collect();
        if words.is_empty() {
            lines.push(String::new());
            continue;
        }
        let mut current_line = String::new();
        for word in words {
            let test = if current_line.is_empty() {
                word.to_string()
            } else {
                format!("{} {}", current_line, word)
            };
            let (tw, _) = gfx.measure_text(&test, 14.0, false);
            if tw > max_width && !current_line.is_empty() {
                lines.push(current_line);
                current_line = word.to_string();
            } else {
                current_line = test;
            }
        }
        if !current_line.is_empty() {
            lines.push(current_line);
        }
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

fn is_mouse_over(state: &PillState, x: f64, y: f64, w: f64, h: f64) -> bool {
    let mx = state.mouse_x.get();
    let my = state.mouse_y.get();
    mx >= x && mx <= x + w && my >= y && my <= y + h
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}
