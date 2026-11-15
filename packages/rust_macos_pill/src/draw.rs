use crate::gfx::{self, Ctx};
use crate::ipc::{Phase, PillPermission, PillStreaming};

use crate::constants::*;
use crate::state::{ClickAction, ClickRegion, PillState, RocketPhase};

pub(crate) fn draw_all(ctx: &Ctx, state: &PillState, view_w: f64, view_h: f64) {
    ctx.paint_clear(view_w, view_h);

    let s = state.ui_scale;
    if s != 1.0 {
        ctx.scale(s, s);
    }

    state.click_regions.borrow_mut().clear();

    let ww = state.draw_width.get();
    let wh = state.draw_height.get();
    let (ox, oy) = state.content_offset();

    ctx.save();
    ctx.translate(ox, oy);

    if state.assistant_active.get() || state.panel_open_t.get() > 0.01 {
        draw_assistant_panel(ctx, state, ww, wh);
    } else if state.flash_t.get() < 0.01 {
        let pill_area_top = wh - PILL_AREA_HEIGHT;
        draw_tooltip(ctx, state, ww, pill_area_top);
    }

    if !state.assistant_active.get() && state.flame_active.get() {
        draw_flame(ctx, state, ww, wh);
    }

    draw_pill(ctx, state, ww, wh);

    if state.flash_blue_active.get() {
        draw_flash_blue(ctx, state, ww, wh);
    }

    if state.assistant_active.get() {
        draw_keyboard_button(ctx, state, ww, wh);
    }

    if !state.assistant_active.get() {
        if !state.fireworks_rockets.borrow().is_empty() {
            draw_fireworks(ctx, state, ww, wh);
        }

        if state.flash_t.get() > 0.01 {
            draw_flash_message(ctx, state, ww, wh);
        }

        if state.transcript_opacity.get() > 0.001 {
            draw_broadcast_transcript(ctx, state, ww, wh);
        }

        draw_cancel_button(ctx, state, ww, wh);
    }

    ctx.restore();
}

pub(crate) fn pill_position(state: &PillState, ww: f64, wh: f64) -> (f64, f64, f64, f64) {
    let expand_t = state.expand_t.get();
    let pill_w = gfx::lerp(MIN_PILL_WIDTH, EXPANDED_PILL_WIDTH, expand_t);
    let pill_h = gfx::lerp(MIN_PILL_HEIGHT, EXPANDED_PILL_HEIGHT, expand_t);
    let pill_x = (ww - pill_w) / 2.0;

    let pill_y = if state.assistant_active.get() || state.panel_open_t.get() > 0.01 {
        let panel_bottom = wh - PANEL_BOTTOM_MARGIN;
        panel_bottom - PILL_BOTTOM_INSET - pill_h
    } else {
        // Collapsed: sit closer to the bottom; expanded: rise up to centered position
        let collapsed_bottom = 4.0;
        let expanded_bottom = (PILL_AREA_HEIGHT - EXPANDED_PILL_HEIGHT) / 2.0;
        let bottom_offset = gfx::lerp(collapsed_bottom, expanded_bottom, expand_t);
        wh - bottom_offset - pill_h
    };

    (pill_x, pill_y, pill_w, pill_h)
}

fn draw_pill(ctx: &Ctx, state: &PillState, ww: f64, wh: f64) {
    let expand_t = state.expand_t.get();
    let (rx, ry, pill_w, pill_h) = pill_position(state, ww, wh);

    let bg_alpha = gfx::lerp(IDLE_BG_ALPHA, ACTIVE_BG_ALPHA, expand_t);
    let radius = gfx::lerp(COLLAPSED_RADIUS, EXPANDED_RADIUS, expand_t);

    let is_typing = state.assistant_active.get()
        && *state.assistant_input_mode.borrow() == "type";
    if is_typing {
        return;
    }

    gfx::rounded_rect(ctx, rx, ry, pill_w, pill_h, radius);
    ctx.set_source_rgba(0.0, 0.0, 0.0, bg_alpha);
    ctx.fill();

    match state.phase.get() {
        Phase::Recording if expand_t > 0.1 => {
            draw_waveform(ctx, rx, ry, pill_w, pill_h, expand_t, state);
            draw_edge_gradient(ctx, rx, ry, pill_w, pill_h, radius, expand_t);
        }
        Phase::Loading if expand_t > 0.1 => {
            draw_loading(ctx, rx, ry, pill_w, pill_h, radius, expand_t, state);
        }
        Phase::Idle if expand_t > 0.5 && (state.hovered.get() || state.assistant_active.get()) => {
            draw_idle_label(ctx, rx, ry, pill_w, pill_h, expand_t);
        }
        _ => {}
    }

    gfx::rounded_rect(ctx, rx + 0.5, ry + 0.5, pill_w - 1.0, pill_h - 1.0, radius - 0.5);
    ctx.set_source_rgba(1.0, 1.0, 1.0, BORDER_ALPHA);
    ctx.set_line_width(1.0);
    ctx.stroke();

    state.click_regions.borrow_mut().push(ClickRegion {
        x: rx, y: ry, w: pill_w, h: pill_h,
        action: ClickAction::Pill,
    });
}

fn draw_waveform(
    ctx: &Ctx, rx: f64, ry: f64, pill_w: f64, pill_h: f64,
    expand_t: f64, state: &PillState,
) {
    let wave_phase = state.wave_phase.get();
    let level = state.current_level.get();
    let baseline = ry + pill_h / 2.0;

    ctx.save();
    gfx::rounded_rect(ctx, rx, ry, pill_w, pill_h, pill_h / 2.0);
    ctx.clip();

    for config in WAVE_CONFIGS {
        let amplitude_factor = (level * config.multiplier).clamp(MIN_AMPLITUDE, MAX_AMPLITUDE);
        let amplitude = (pill_h * 0.75 * amplitude_factor).max(1.0);
        let phase = wave_phase + config.phase_offset;
        let alpha = config.opacity * expand_t;

        ctx.set_source_rgba(1.0, 1.0, 1.0, alpha);
        ctx.set_line_width(STROKE_WIDTH);
        ctx.set_line_cap_round();
        ctx.set_line_join_round();

        let pad = pill_h * 0.1;
        let wave_w = pill_w - pad * 2.0;
        let segments = (wave_w / 2.0).max(72.0) as i32;
        for i in 0..=segments {
            let t = i as f64 / segments as f64;
            let x = rx + pad + wave_w * t;
            let theta = config.frequency * t * TAU + phase;
            let y = baseline + amplitude * theta.sin();

            if i == 0 {
                ctx.move_to(x, y);
            } else {
                ctx.line_to(x, y);
            }
        }
        ctx.stroke();
    }

    ctx.restore();
}

fn draw_edge_gradient(
    ctx: &Ctx, rx: f64, ry: f64, pill_w: f64, pill_h: f64,
    radius: f64, expand_t: f64,
) {
    ctx.save();
    gfx::rounded_rect(ctx, rx, ry, pill_w, pill_h, radius);
    ctx.clip();

    let alpha = 0.9 * expand_t;

    // Left edge gradient
    ctx.draw_linear_gradient_in_rect(
        rx, ry, pill_w * 0.18, pill_h,
        rx, 0.0, rx + pill_w * 0.18, 0.0,
        &[
            (0.0, 0.0, 0.0, 0.0, alpha),
            (1.0, 0.0, 0.0, 0.0, 0.0),
        ],
    );

    // Right edge gradient
    let right_start = rx + pill_w * 0.85;
    ctx.draw_linear_gradient_in_rect(
        right_start, ry, pill_w * 0.15, pill_h,
        right_start, 0.0, rx + pill_w, 0.0,
        &[
            (0.0, 0.0, 0.0, 0.0, 0.0),
            (1.0, 0.0, 0.0, 0.0, alpha),
        ],
    );

    ctx.restore();
}

#[allow(clippy::too_many_arguments)]
fn draw_loading(
    ctx: &Ctx, rx: f64, ry: f64, pill_w: f64, pill_h: f64,
    radius: f64, expand_t: f64, state: &PillState,
) {
    ctx.save();
    gfx::rounded_rect(ctx, rx, ry, pill_w, pill_h, radius);
    ctx.clip();

    let bar_h = 2.0;
    let bar_y = ry + (pill_h - bar_h) / 2.0;
    let pad = pill_h * 0.1;
    let track_x = rx + pad;
    let track_w = pill_w - pad * 2.0;

    // Track line
    ctx.set_source_rgba(1.0, 1.0, 1.0, 0.15 * expand_t);
    ctx.set_line_width(bar_h);
    ctx.set_line_cap_round();
    ctx.move_to(track_x, bar_y + bar_h / 2.0);
    ctx.line_to(track_x + track_w, bar_y + bar_h / 2.0);
    ctx.stroke();

    // Moving indicator
    let indicator_w = track_w * LOADING_BAR_WIDTH_FRAC;
    let offset = state.loading_offset.get();
    let ind_x = track_x + (track_w + indicator_w) * offset - indicator_w;

    ctx.set_source_rgba(1.0, 1.0, 1.0, 0.7 * expand_t);
    ctx.set_line_width(bar_h);
    ctx.set_line_cap_round();

    let draw_left = ind_x.max(track_x);
    let draw_right = (ind_x + indicator_w).min(track_x + track_w);
    if draw_right > draw_left {
        ctx.move_to(draw_left, bar_y + bar_h / 2.0);
        ctx.line_to(draw_right, bar_y + bar_h / 2.0);
        ctx.stroke();
    }

    ctx.restore();

    draw_edge_gradient(ctx, rx, ry, pill_w, pill_h, radius, expand_t);
}

fn draw_idle_label(ctx: &Ctx, rx: f64, ry: f64, pill_w: f64, pill_h: f64, expand_t: f64) {
    ctx.set_source_rgba(1.0, 1.0, 1.0, 0.4 * expand_t);
    ctx.select_font_face("sans-serif", false, true);
    ctx.set_font_size(11.0);
    let text = "Click to dictate";
    let extents = ctx.text_extents(text);
    let tx = rx + (pill_w - extents.width) / 2.0 - extents.x_bearing;
    let ty = ry + (pill_h - extents.height) / 2.0 - extents.y_bearing;
    ctx.move_to(tx, ty);
    ctx.show_text(text);
}

// ── Tooltip (dictation style selector) ────────────────────────────

fn draw_tooltip(ctx: &Ctx, state: &PillState, ww: f64, pill_area_top: f64) {
    let tooltip_t = state.tooltip_t.get();
    if tooltip_t < 0.01 {
        return;
    }

    let style_name = state.style_name.borrow();
    if state.style_count.get() <= 1 || style_name.is_empty() {
        return;
    }

    let tooltip_w = TOOLTIP_FIXED_WIDTH;
    state.tooltip_width.set(tooltip_w);

    let tooltip_rx = (ww - tooltip_w) / 2.0;
    let y_offset = (1.0 - tooltip_t) * 4.0;
    let tooltip_ry = pill_area_top - TOOLTIP_GAP - TOOLTIP_HEIGHT + y_offset;
    let alpha = tooltip_t;

    gfx::rounded_rect(ctx, tooltip_rx, tooltip_ry, tooltip_w, TOOLTIP_HEIGHT, TOOLTIP_RADIUS);
    ctx.set_source_rgba(0.0, 0.0, 0.0, 0.92 * alpha);
    ctx.fill();

    let center_y = tooltip_ry + TOOLTIP_HEIGHT / 2.0;
    let chevron_area = 28.0;
    let padding_h = 12.0;

    // Left chevron (SF Symbol)
    let left_cx = tooltip_rx + padding_h + 6.0;
    ctx.set_source_rgba(1.0, 1.0, 1.0, 0.7 * alpha);
    ctx.draw_symbol("chevron.left", left_cx, center_y, 10.0);

    // Right chevron (SF Symbol)
    let right_cx = tooltip_rx + tooltip_w - padding_h - 6.0;
    ctx.set_source_rgba(1.0, 1.0, 1.0, 0.7 * alpha);
    ctx.draw_symbol("chevron.right", right_cx, center_y, 10.0);

    // Style name text
    ctx.set_source_rgba(1.0, 1.0, 1.0, 0.9 * alpha);
    ctx.select_font_face("sans-serif", false, true);
    ctx.set_font_size(12.0);
    let text_extents = ctx.text_extents(&style_name);
    let text_area_left = tooltip_rx + padding_h + chevron_area;
    let text_area_right = tooltip_rx + tooltip_w - padding_h - chevron_area;
    let text_area_center = (text_area_left + text_area_right) / 2.0;
    let tx = text_area_center - text_extents.width / 2.0 - text_extents.x_bearing;
    let ty = center_y - text_extents.height / 2.0 - text_extents.y_bearing;

    ctx.save();
    ctx.rectangle(text_area_left, tooltip_ry, text_area_right - text_area_left, TOOLTIP_HEIGHT);
    ctx.clip();
    ctx.move_to(tx, ty);
    ctx.show_text(&style_name);
    ctx.restore();

    // Click regions for tooltip
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

fn draw_flash_message(ctx: &Ctx, state: &PillState, ww: f64, wh: f64) {
    let flash_t = state.flash_t.get();
    if flash_t < 0.01 {
        return;
    }

    let message = state.flash_message.borrow();
    if message.is_empty() {
        return;
    }

    let is_error = state.flash_is_error.get();
    let action_label = state.flash_action_label.borrow();
    let has_action = action_label.is_some();

    ctx.select_font_face("sans-serif", false, true);
    ctx.set_font_size(12.0);
    let text_extents = ctx.text_extents(&message);

    let action_w = if let Some(ref label) = *action_label {
        ctx.select_font_face("sans-serif", false, true);
        ctx.set_font_size(11.0);
        let ext = ctx.text_extents(label);
        ext.width + FLASH_ACTION_PADDING_H * 2.0
    } else {
        0.0
    };
    let action_section = if has_action { FLASH_ACTION_GAP + action_w } else { 0.0 };

    let flash_w = (text_extents.width + FLASH_PADDING_H * 2.0 + action_section).max(80.0);

    let scale = FLASH_MIN_SCALE + (1.0 - FLASH_MIN_SCALE) * flash_t;
    let alpha = flash_t;

    let (_, pill_y, _, _) = pill_position(state, ww, wh);
    let full_x = (ww - flash_w) / 2.0;
    let full_y = pill_y - FLASH_GAP - FLASH_HEIGHT;

    let center_x = full_x + flash_w / 2.0;
    let center_y = full_y + FLASH_HEIGHT / 2.0;

    ctx.save();
    ctx.translate(center_x, center_y);
    ctx.scale(scale, scale);
    ctx.translate(-center_x, -center_y);

    // Background
    let (bg_r, bg_g, bg_b) = if is_error { (0.35, 0.05, 0.05) } else { (0.0, 0.0, 0.0) };
    gfx::rounded_rect(ctx, full_x, full_y, flash_w, FLASH_HEIGHT, FLASH_RADIUS);
    ctx.set_source_rgba(bg_r, bg_g, bg_b, 0.92 * alpha);
    ctx.fill();

    // Message text
    ctx.set_source_rgba(1.0, 1.0, 1.0, 0.9 * alpha);
    ctx.select_font_face("sans-serif", false, true);
    ctx.set_font_size(12.0);
    let text_left = if has_action {
        full_x + FLASH_PADDING_H
    } else {
        full_x + (flash_w - text_extents.width) / 2.0
    };
    let tx = text_left - text_extents.x_bearing;
    let ty = full_y + (FLASH_HEIGHT - text_extents.height) / 2.0 - text_extents.y_bearing;
    ctx.move_to(tx, ty);
    ctx.show_text(&message);

    // Action button
    if let Some(ref label) = *action_label {
        let btn_x = full_x + flash_w - FLASH_PADDING_H - action_w;
        let btn_y = full_y + (FLASH_HEIGHT - FLASH_ACTION_HEIGHT) / 2.0;

        gfx::rounded_rect(ctx, btn_x, btn_y, action_w, FLASH_ACTION_HEIGHT, FLASH_ACTION_RADIUS);
        ctx.set_source_rgba(1.0, 1.0, 1.0, 0.2 * alpha);
        ctx.fill();

        ctx.set_source_rgba(1.0, 1.0, 1.0, 0.95 * alpha);
        ctx.select_font_face("sans-serif", false, true);
        ctx.set_font_size(11.0);
        let label_ext = ctx.text_extents(label);
        let lx = btn_x + (action_w - label_ext.width) / 2.0 - label_ext.x_bearing;
        let ly = btn_y + (FLASH_ACTION_HEIGHT - label_ext.height) / 2.0 - label_ext.y_bearing;
        ctx.move_to(lx, ly);
        ctx.show_text(label);

        state.click_regions.borrow_mut().push(ClickRegion {
            x: btn_x,
            y: btn_y,
            w: action_w,
            h: FLASH_ACTION_HEIGHT,
            action: ClickAction::FlashAction,
        });
    }

    ctx.restore();
}

// ── Flash blue border ────────────────────────────────────────────

fn draw_flash_blue(ctx: &Ctx, state: &PillState, ww: f64, wh: f64) {
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
    let radius = gfx::lerp(COLLAPSED_RADIUS, EXPANDED_RADIUS, expand_t) + FLASH_BLUE_INSET;

    let (gr, gg, gb) = FLASH_BLUE_GLOW_COLOR;
    gfx::rounded_rect(ctx, rx - 1.5, ry - 1.5, rw + 3.0, rh + 3.0, radius + 1.5);
    ctx.set_source_rgba(gr, gg, gb, 0.35 * alpha);
    ctx.set_line_width(FLASH_BLUE_BORDER_WIDTH + 2.0);
    ctx.stroke();

    let (r, g, b) = FLASH_BLUE_COLOR;
    gfx::rounded_rect(ctx, rx, ry, rw, rh, radius);
    ctx.set_source_rgba(r, g, b, alpha);
    ctx.set_line_width(FLASH_BLUE_BORDER_WIDTH);
    ctx.stroke();
}

// ── Broadcast transcript ─────────────────────────────────────────

fn draw_broadcast_transcript(ctx: &Ctx, state: &PillState, ww: f64, wh: f64) {
    let alpha = state.transcript_opacity.get();
    if alpha < 0.01 {
        return;
    }
    let text = state.transcript_text.borrow();
    if text.is_empty() {
        return;
    }

    ctx.select_font_face("sans-serif", false, false);
    ctx.set_font_size(TRANSCRIPT_FONT_SIZE);
    let text_extents = ctx.text_extents(&text);
    let box_w = (text_extents.width + TRANSCRIPT_PADDING_H * 2.0).min(TRANSCRIPT_MAX_WIDTH);

    let (_, pill_y, _, _) = pill_position(state, ww, wh);
    let box_x = (ww - box_w) / 2.0;
    let rise = (1.0 - alpha) * 6.0;
    let box_y = pill_y - TRANSCRIPT_GAP - TRANSCRIPT_HEIGHT + rise;

    gfx::rounded_rect(ctx, box_x, box_y, box_w, TRANSCRIPT_HEIGHT, TRANSCRIPT_RADIUS);
    ctx.set_source_rgba(0.0, 0.0, 0.0, alpha);
    ctx.fill();

    gfx::rounded_rect(
        ctx,
        box_x + 0.5,
        box_y + 0.5,
        box_w - 1.0,
        TRANSCRIPT_HEIGHT - 1.0,
        TRANSCRIPT_RADIUS - 0.5,
    );
    ctx.set_source_rgba(0.45, 0.75, 1.0, 0.35 * alpha);
    ctx.set_line_width(1.0);
    ctx.stroke();

    let tx = box_x + (box_w - text_extents.width) / 2.0 - text_extents.x_bearing;
    let ty = box_y + (TRANSCRIPT_HEIGHT - text_extents.height) / 2.0 - text_extents.y_bearing;
    ctx.set_source_rgba(1.0, 1.0, 1.0, 0.95 * alpha);
    ctx.move_to(tx, ty);
    ctx.show_text(&text);
}

// ── Flame ────────────────────────────────────────────────────────

fn draw_flame_tongue(ctx: &Ctx, cx: f64, base_y: f64, h: f64, hw: f64, sway: f64,
    gradient_stops: &[(f64, f64, f64, f64, f64)],
) {
    use std::f64::consts::PI;
    let tip_x = cx + sway;
    let tip_y = base_y - h;
    let base_r = hw.min(h * 0.15);

    ctx.save();
    ctx.new_sub_path();
    // Start at left side, just above the rounded base
    ctx.move_to(cx - hw, base_y - base_r);
    // Left edge: bulges out slightly in lower third, then narrows to tip
    ctx.curve_to(
        cx - hw * 1.15, base_y - h * 0.35,
        cx - hw * 0.12 + sway * 0.3, base_y - h * 0.72,
        tip_x, tip_y,
    );
    // Right edge: mirror, tip back down to base
    ctx.curve_to(
        cx + hw * 0.12 + sway * 0.3, base_y - h * 0.72,
        cx + hw * 1.15, base_y - h * 0.35,
        cx + hw, base_y - base_r,
    );
    // Rounded bottom: arc from right to left
    ctx.arc(cx, base_y - base_r, hw, 0.0, PI);
    ctx.close_path();
    ctx.clip();
    ctx.draw_gradient_raw(cx, base_y, cx, tip_y, gradient_stops);
    ctx.restore();
}

fn draw_flame(ctx: &Ctx, state: &PillState, ww: f64, wh: f64) {
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
        draw_flame_tongue(ctx, cx, base_y, h * 1.2, hw * 1.5, sway * 1.1,
            &[
                (0.0, 0.7, 0.7, 0.7, alpha * 0.15),
                (0.4, 0.4, 0.4, 0.4, alpha * 0.08),
                (1.0, 0.0, 0.0, 0.0, 0.0),
            ],
        );

        // Layer 2: main flame body
        draw_flame_tongue(ctx, cx, base_y, h, hw, sway,
            &[
                (0.0, 1.0, 1.0, 1.0, alpha * 0.85),
                (0.25, 1.0, 1.0, 1.0, alpha * 0.65),
                (0.55, 0.8, 0.8, 0.8, alpha * 0.3),
                (1.0, 0.0, 0.0, 0.0, 0.0),
            ],
        );

        // Layer 3: inner bright core — narrow, hot white
        draw_flame_tongue(ctx, cx, base_y, h * 0.55, hw * 0.35, sway * 0.5,
            &[
                (0.0, 1.0, 1.0, 1.0, alpha * 0.95),
                (0.5, 1.0, 1.0, 1.0, alpha * 0.5),
                (1.0, 1.0, 1.0, 1.0, 0.0),
            ],
        );
    }
}

// ── Fireworks ────────────────────────────────────────────────────

fn draw_fireworks(ctx: &Ctx, state: &PillState, _ww: f64, _wh: f64) {
    let rockets = state.fireworks_rockets.borrow();

    for rocket in rockets.iter() {
        let (cr, cg, cb) = rocket.color;

        // Trail
        if rocket.trail.len() > 1 && rocket.trail_alpha > 0.01 {
            let n = rocket.trail.len();
            ctx.set_line_width(FIREWORKS_ROCKET_LINE_WIDTH);
            ctx.set_line_cap_round();
            for i in 1..n {
                let alpha = (i as f64 / n as f64) * rocket.trail_alpha * 0.8;
                ctx.set_source_rgba(cr, cg, cb, alpha);
                ctx.move_to(rocket.trail[i - 1].0, rocket.trail[i - 1].1);
                ctx.line_to(rocket.trail[i].0, rocket.trail[i].1);
                ctx.stroke();
            }
        }

        // Bright head while rising
        if rocket.phase == RocketPhase::Rising {
            let hs = FIREWORKS_HEAD_SIZE / 2.0;
            ctx.set_source_rgba(cr, cg, cb, 0.95);
            gfx::rounded_rect(ctx, rocket.x - hs, rocket.y - hs, FIREWORKS_HEAD_SIZE, FIREWORKS_HEAD_SIZE, hs);
            ctx.fill();
        }

        // Sparks
        ctx.set_line_width(FIREWORKS_SPARK_LINE_WIDTH);
        ctx.set_line_cap_round();
        for spark in &rocket.sparks {
            if spark.life <= 0.0 {
                continue;
            }
            let alpha = spark.life.clamp(0.0, 1.0) * 0.9;
            ctx.set_source_rgba(cr, cg, cb, alpha);

            let speed = (spark.vx * spark.vx + spark.vy * spark.vy).sqrt();
            let line_len = (speed * 0.04).clamp(2.0, 10.0);
            let (nx, ny) = if speed > 0.01 {
                (spark.vx / speed, spark.vy / speed)
            } else {
                (0.0, -1.0)
            };

            ctx.move_to(spark.x - nx * line_len, spark.y - ny * line_len);
            ctx.line_to(spark.x, spark.y);
            ctx.stroke();
        }
    }
}

// ── Assistant panel ───────────────────────────────────────────────

fn draw_assistant_panel(ctx: &Ctx, state: &PillState, ww: f64, wh: f64) {
    let panel_t = state.panel_open_t.get();
    if panel_t < 0.01 {
        return;
    }

    let is_compact = state.assistant_compact.get();
    let is_typing = *state.assistant_input_mode.borrow() == "type";

    let panel_w = if is_compact { PANEL_COMPACT_WIDTH } else { PANEL_EXPANDED_WIDTH };
    let panel_x = (ww - panel_w) / 2.0;
    let panel_y = PANEL_TOP_MARGIN;
    let panel_h = wh - PANEL_TOP_MARGIN - PANEL_BOTTOM_MARGIN;

    let alpha = panel_t;
    let y_shift = (1.0 - panel_t) * 12.0;

    // Panel background
    ctx.save();
    gfx::rounded_rect(ctx, panel_x, panel_y + y_shift, panel_w, panel_h, PANEL_RADIUS);
    ctx.set_source_rgba(0.0, 0.0, 0.0, PANEL_BG_ALPHA * alpha);
    ctx.fill();

    gfx::rounded_rect(ctx, panel_x + 0.5, panel_y + y_shift + 0.5, panel_w - 1.0, panel_h - 1.0, PANEL_RADIUS - 0.5);
    ctx.set_source_rgba(1.0, 1.0, 1.0, PANEL_BORDER_ALPHA * alpha);
    ctx.set_line_width(1.0);
    ctx.stroke();
    ctx.restore();

    let py = panel_y + y_shift;

    let pill_top_in_panel = panel_h - PILL_BOTTOM_INSET - EXPANDED_PILL_HEIGHT;

    if is_compact {
        draw_compact_content(ctx, panel_x, py, panel_w, pill_top_in_panel, alpha, state);
    } else {
        ctx.save();
        gfx::rounded_rect(ctx, panel_x, py, panel_w, panel_h, PANEL_RADIUS);
        ctx.clip();

        let content_x = panel_x + PANEL_CONTENT_SIDE_INSET;
        let content_w = panel_w - PANEL_CONTENT_SIDE_INSET * 2.0;

        let scroll_bottom = if is_typing {
            py + panel_h - PANEL_INPUT_HEIGHT
        } else {
            py + panel_h
        };
        let scroll_h = (scroll_bottom - py).max(0.0);
        state.viewport_height.set(scroll_h);

        let top_pad = PANEL_TRANSCRIPT_TOP_OFFSET + SCROLL_TOP_PAD;
        let bottom_pad = if is_typing {
            SCROLL_BOTTOM_PAD
        } else {
            PILL_BOTTOM_INSET + EXPANDED_PILL_HEIGHT + SCROLL_BOTTOM_PAD
        };

        draw_transcript(ctx, state, content_x, py, content_w, scroll_h, alpha, top_pad, bottom_pad);

        // Top gradient
        let grad_h = PANEL_TRANSCRIPT_TOP_OFFSET + 16.0;
        ctx.draw_linear_gradient_in_rect(
            panel_x, py, panel_w, grad_h,
            0.0, py, 0.0, py + grad_h,
            &[
                (0.0, 0.0, 0.0, 0.0, 0.98 * alpha),
                (0.38, 0.0, 0.0, 0.0, 0.82 * alpha),
                (1.0, 0.0, 0.0, 0.0, 0.0),
            ],
        );

        // Bottom gradient
        let bot_area = if is_typing { 0.0 } else { PILL_BOTTOM_INSET + EXPANDED_PILL_HEIGHT };
        let bot_grad_h = bot_area + 16.0;
        let bot_y = scroll_bottom - bot_grad_h;
        ctx.draw_linear_gradient_in_rect(
            panel_x, bot_y, panel_w, bot_grad_h,
            0.0, bot_y, 0.0, scroll_bottom,
            &[
                (0.0, 0.0, 0.0, 0.0, 0.0),
                (0.28, 0.0, 0.0, 0.0, 0.82 * alpha),
                (1.0, 0.0, 0.0, 0.0, 0.98 * alpha),
            ],
        );

        ctx.restore();

        // Header elements drawn on top of gradients
        if let Some(ref prompt) = *state.assistant_user_prompt.borrow() {
            draw_user_prompt_preview(ctx, panel_x, py, panel_w, prompt, alpha);
        }

        // Input bar
        if is_typing {
            let input_y = py + panel_h - PANEL_INPUT_HEIGHT;
            ctx.set_source_rgba(1.0, 1.0, 1.0, 0.1 * alpha);
            ctx.set_line_width(1.0);
            ctx.move_to(panel_x + PANEL_CONTENT_SIDE_INSET, input_y);
            ctx.line_to(panel_x + panel_w - PANEL_CONTENT_SIDE_INSET, input_y);
            ctx.stroke();

            // Send button
            let send_btn_size = 28.0;
            let send_x = panel_x + panel_w - PANEL_CONTENT_SIDE_INSET - send_btn_size;
            let send_y = input_y + (PANEL_INPUT_HEIGHT - send_btn_size) / 2.0;
            let has_text = !state.entry_text.borrow().trim().is_empty();
            let text_alpha = if has_text { 0.82 } else { 0.2 };

            ctx.set_source_rgba(1.0, 1.0, 1.0, text_alpha * alpha);
            let cx = send_x + send_btn_size / 2.0;
            let cy = send_y + send_btn_size / 2.0;
            ctx.draw_symbol("arrow.up.circle.fill", cx, cy, 18.0);

            if has_text {
                state.click_regions.borrow_mut().push(ClickRegion {
                    x: send_x, y: send_y, w: send_btn_size, h: send_btn_size,
                    action: ClickAction::SendButton,
                });
            }
        }
    }

    // Close button drawn last
    draw_close_button(ctx, panel_x + PANEL_HEADER_OFFSET_LEFT, py + PANEL_HEADER_OFFSET_TOP,
        HEADER_BUTTON_SIZE, alpha);
    state.click_regions.borrow_mut().push(ClickRegion {
        x: panel_x + PANEL_HEADER_OFFSET_LEFT,
        y: py + PANEL_HEADER_OFFSET_TOP,
        w: HEADER_BUTTON_SIZE, h: HEADER_BUTTON_SIZE,
        action: ClickAction::AssistantClose,
    });
}

fn draw_compact_content(
    ctx: &Ctx, panel_x: f64, panel_y: f64, panel_w: f64,
    content_height: f64, alpha: f64, state: &PillState,
) {
    let text = "What can I help you with?";
    let text_alpha = if state.phase.get() == Phase::Recording { 0.96 } else { 0.8 };
    ctx.set_source_rgba(1.0, 1.0, 1.0, text_alpha * alpha);
    ctx.select_font_face("sans-serif", false, false);
    ctx.set_font_size(18.0);
    let extents = ctx.text_extents(text);
    let tx = panel_x + (panel_w - extents.width) / 2.0 - extents.x_bearing;
    let ty = panel_y + (content_height - extents.height) / 2.0 - extents.y_bearing;
    ctx.move_to(tx, ty);
    ctx.show_text(text);
}

#[allow(clippy::too_many_arguments)]
fn draw_transcript(
    ctx: &Ctx, state: &PillState,
    area_x: f64, area_y: f64, area_w: f64, area_h: f64, alpha: f64,
    top_pad: f64, bottom_pad: f64,
) {
    let messages = state.assistant_messages.borrow();
    let streaming = state.assistant_streaming.borrow();
    let permissions = state.assistant_permissions.borrow();

    if messages.is_empty() && permissions.is_empty() {
        return;
    }

    ctx.save();
    ctx.rectangle(area_x, area_y, area_w, area_h);
    ctx.clip();

    let scroll = state.scroll_offset.get();
    let mut y = area_y + top_pad - scroll;

    ctx.select_font_face("sans-serif", false, false);
    ctx.set_font_size(14.0);

    let line_height = 20.0;

    for (i, msg) in messages.iter().enumerate() {
        if i > 0 {
            y += 16.0;
            ctx.set_source_rgba(1.0, 1.0, 1.0, 0.45 * alpha);
            ctx.set_line_width(1.0);
            ctx.move_to(area_x, y);
            ctx.line_to(area_x + 36.0, y);
            ctx.stroke();
            y += 8.0;
        }

        if let Some(ref stream) = *streaming {
            if stream.message_id == msg.id {
                y = draw_streaming_activity(ctx, stream, area_x, y, area_w, alpha);
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

            ctx.set_source_rgba(1.0, 1.0, 1.0, 0.5 * alpha);
            ctx.select_font_face("sans-serif", false, false);
            ctx.set_font_size(12.0);

            draw_wrench_icon(ctx, area_x, y + 2.0, 12.0, 0.5 * alpha);
            let text_x = area_x + 18.0;
            ctx.move_to(text_x, y + 12.0);
            ctx.show_text(&display);
            y += 18.0;
        } else if let Some(ref content) = msg.content {
            let color_alpha = if msg.is_error { 0.94 } else { 0.92 };
            let (r, g, b) = if msg.is_error { (1.0, 0.4, 0.4) } else { (1.0, 1.0, 1.0) };

            ctx.set_source_rgba(r, g, b, color_alpha * alpha);
            ctx.select_font_face("sans-serif", false, false);
            ctx.set_font_size(14.0);

            let lines = wrap_text(ctx, content, area_w);
            for line in &lines {
                ctx.move_to(area_x, y + line_height * 0.75);
                ctx.show_text(line);
                y += line_height;
            }
        } else {
            y = draw_thinking_text(ctx, area_x, y, alpha, state);
        }
    }

    for perm in permissions.iter() {
        y += 12.0;
        y = draw_permission_card(ctx, state, perm, area_x, y, area_w, alpha);
    }

    let total_height = y + scroll - area_y + bottom_pad;
    state.content_height.set(total_height);

    ctx.restore();
}

fn draw_streaming_activity(
    ctx: &Ctx, streaming: &PillStreaming,
    x: f64, mut y: f64, _w: f64, alpha: f64,
) -> f64 {
    ctx.select_font_face("sans-serif", true, false);
    ctx.set_font_size(12.0);
    ctx.set_source_rgba(1.0, 1.0, 1.0, 0.5 * alpha);

    for tc in &streaming.tool_calls {
        let text = if tc.done {
            format!("Used {}", tc.name)
        } else {
            format!("Using {}…", tc.name)
        };
        ctx.move_to(x, y + 12.0);
        ctx.show_text(&text);
        y += 16.0;
    }

    if !streaming.reasoning.is_empty() {
        let label = if streaming.is_streaming { "Thinking…" } else { "Thought process" };
        ctx.move_to(x, y + 12.0);
        ctx.show_text(label);
        y += 16.0;
    }

    y
}

fn draw_thinking_text(
    ctx: &Ctx, x: f64, y: f64, alpha: f64, state: &PillState,
) -> f64 {
    let text = "Thinking";
    ctx.select_font_face("sans-serif", false, false);
    ctx.set_font_size(14.0);
    let extents = ctx.text_extents(text);
    let text_y = y + 14.0;

    // Shimmer effect: sweep a bright spot across the text
    let shimmer = state.shimmer_phase.get();
    let full_width = extents.width;
    let grad_center = shimmer * 4.0 - 1.0; // sweeps from -1 to 3

    let mut char_x = x;
    for ch in text.chars() {
        let ch_str = ch.to_string();
        let ch_ext = ctx.text_extents(&ch_str);
        let pos = if full_width > 0.0 { (char_x - x) / full_width } else { 0.0 };
        let dist = (pos - grad_center).abs();
        let ch_alpha = gfx::lerp(0.92, 0.34, (dist * 2.0).clamp(0.0, 1.0));

        ctx.set_source_rgba(1.0, 1.0, 1.0, ch_alpha * alpha);
        ctx.move_to(char_x, text_y);
        ctx.show_text(&ch_str);
        char_x += ch_ext.width;
    }

    y + 20.0
}

fn draw_permission_card(
    ctx: &Ctx, state: &PillState, perm: &PillPermission,
    x: f64, y: f64, w: f64, alpha: f64,
) -> f64 {
    let card_h = PERM_CARD_HEIGHT;

    gfx::rounded_rect(ctx, x, y, w, card_h, 12.0);
    ctx.set_source_rgba(1.0, 1.0, 1.0, 0.06 * alpha);
    ctx.fill();

    gfx::rounded_rect(ctx, x + 0.5, y + 0.5, w - 1.0, card_h - 1.0, 11.5);
    ctx.set_source_rgba(1.0, 1.0, 1.0, 0.12 * alpha);
    ctx.set_line_width(1.0);
    ctx.stroke();

    let tool_label = perm.description.as_deref().unwrap_or(&perm.tool_name);
    ctx.set_source_rgba(1.0, 1.0, 1.0, 0.82 * alpha);
    ctx.select_font_face("sans-serif", false, true);
    ctx.set_font_size(12.0);
    ctx.move_to(x + 12.0, y + 18.0);
    ctx.show_text(tool_label);

    if let Some(ref reason) = perm.reason {
        ctx.set_source_rgba(1.0, 1.0, 1.0, 0.5 * alpha);
        ctx.select_font_face("sans-serif", false, false);
        ctx.set_font_size(11.0);
        ctx.move_to(x + 12.0, y + 32.0);
        ctx.show_text(reason);
    }

    let btn_y = y + card_h - PERM_BUTTON_HEIGHT - 8.0;
    let btn_labels = [("Deny", 0.5), ("Allow", 0.82), ("Always Allow", 0.82)];
    let mut btn_x = x + w - 12.0;

    for (i, (label, text_alpha)) in btn_labels.iter().rev().enumerate() {
        let btn_w = if i == 0 { PERM_BUTTON_WIDTH + 16.0 } else { PERM_BUTTON_WIDTH };
        btn_x -= btn_w;

        gfx::rounded_rect(ctx, btn_x, btn_y, btn_w, PERM_BUTTON_HEIGHT, 6.0);
        ctx.set_source_rgba(1.0, 1.0, 1.0, 0.08 * alpha);
        ctx.fill();

        gfx::rounded_rect(ctx, btn_x + 0.5, btn_y + 0.5, btn_w - 1.0, PERM_BUTTON_HEIGHT - 1.0, 5.5);
        ctx.set_source_rgba(1.0, 1.0, 1.0, 0.15 * alpha);
        ctx.set_line_width(1.0);
        ctx.stroke();

        ctx.set_source_rgba(1.0, 1.0, 1.0, text_alpha * alpha);
        ctx.select_font_face("sans-serif", false, false);
        ctx.set_font_size(11.0);
        let ext = ctx.text_extents(label);
        ctx.move_to(
            btn_x + (btn_w - ext.width) / 2.0 - ext.x_bearing,
            btn_y + (PERM_BUTTON_HEIGHT - ext.height) / 2.0 - ext.y_bearing,
        );
        ctx.show_text(label);

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
    ctx: &Ctx, panel_x: f64, panel_y: f64, panel_w: f64,
    prompt: &str, alpha: f64,
) {
    ctx.set_source_rgba(1.0, 1.0, 1.0, 0.5 * alpha);
    ctx.select_font_face("sans-serif", false, false);
    ctx.set_font_size(14.0);

    let max_w = panel_w * 0.5;
    let mut display = prompt.to_string();
    loop {
        let ext = ctx.text_extents(&display);
        if ext.width <= max_w || display.len() < 4 {
            break;
        }
        display.truncate(display.len() - 4);
        display.push('…');
    }

    let ext = ctx.text_extents(&display);
    let tx = panel_x + panel_w - PANEL_HEADER_OFFSET_RIGHT - ext.width - ext.x_bearing;
    let ty = panel_y + PANEL_HEADER_OFFSET_TOP + HEADER_BUTTON_SIZE / 2.0 - ext.height / 2.0 - ext.y_bearing;
    ctx.move_to(tx, ty);
    ctx.show_text(&display);
}

fn draw_close_button(ctx: &Ctx, x: f64, y: f64, size: f64, alpha: f64) {
    gfx::rounded_rect(ctx, x, y, size, size, size / 4.0);
    ctx.set_source_rgba(1.0, 1.0, 1.0, 0.06 * alpha);
    ctx.fill();

    ctx.set_source_rgba(1.0, 1.0, 1.0, 0.82 * alpha);
    ctx.draw_symbol("xmark", x + size / 2.0, y + size / 2.0, 11.0);
}

fn draw_keyboard_button(ctx: &Ctx, state: &PillState, ww: f64, wh: f64) {
    let kb_t = state.kb_button_t.get();
    if kb_t < 0.01 {
        return;
    }

    let (_, pill_y, _, _) = pill_position(state, ww, wh);
    let pill_center_x = ww / 2.0;

    let target_x = pill_center_x + EXPANDED_PILL_WIDTH / 2.0 + KB_BUTTON_GAP;
    let hidden_x = pill_center_x - KB_BUTTON_SIZE / 2.0;
    let btn_x = gfx::lerp(hidden_x, target_x, kb_t);
    let btn_y = pill_y + (EXPANDED_PILL_HEIGHT - KB_BUTTON_SIZE) / 2.0;
    let scale = gfx::lerp(0.5, 1.0, kb_t);
    let alpha = kb_t;

    ctx.save();
    ctx.translate(btn_x + KB_BUTTON_SIZE / 2.0, btn_y + KB_BUTTON_SIZE / 2.0);
    ctx.scale(scale, scale);
    ctx.translate(-(KB_BUTTON_SIZE / 2.0), -(KB_BUTTON_SIZE / 2.0));

    ctx.arc(KB_BUTTON_SIZE / 2.0, KB_BUTTON_SIZE / 2.0, KB_BUTTON_SIZE / 2.0, 0.0, TAU);
    ctx.set_source_rgba(0.0, 0.0, 0.0, 0.92 * alpha);
    ctx.fill();

    ctx.arc(KB_BUTTON_SIZE / 2.0, KB_BUTTON_SIZE / 2.0, KB_BUTTON_SIZE / 2.0 - 0.5, 0.0, TAU);
    ctx.set_source_rgba(1.0, 1.0, 1.0, BORDER_ALPHA * alpha);
    ctx.set_line_width(1.0);
    ctx.stroke();

    ctx.set_source_rgba(1.0, 1.0, 1.0, 0.7 * alpha);
    ctx.draw_symbol("keyboard", KB_BUTTON_SIZE / 2.0, KB_BUTTON_SIZE / 2.0, 13.0);

    ctx.restore();

    if kb_t > 0.5 {
        state.click_regions.borrow_mut().push(ClickRegion {
            x: btn_x, y: btn_y, w: KB_BUTTON_SIZE, h: KB_BUTTON_SIZE,
            action: ClickAction::KeyboardButton,
        });
    }
}

fn draw_cancel_button(ctx: &Ctx, state: &PillState, ww: f64, wh: f64) {
    let t = state.cancel_t.get();
    if t < 0.01 {
        return;
    }

    let (pill_x, pill_y, pill_w, _) = pill_position(state, ww, wh);
    let btn_x = pill_x + pill_w - CANCEL_BUTTON_SIZE / 2.0 + 2.0;
    let btn_y = pill_y - CANCEL_BUTTON_SIZE / 2.0 - 2.0;
    let cx = btn_x + CANCEL_BUTTON_SIZE / 2.0;
    let cy = btn_y + CANCEL_BUTTON_SIZE / 2.0;

    let scale = 0.5 + 0.5 * t;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);

    ctx.set_source_rgba(0.46, 0.46, 0.46, t);
    ctx.draw_symbol("xmark.circle.fill", cx, cy, CANCEL_BUTTON_SIZE - 2.0);

    ctx.restore();

    if t > 0.5 {
        state.click_regions.borrow_mut().push(ClickRegion {
            x: btn_x, y: btn_y, w: CANCEL_BUTTON_SIZE, h: CANCEL_BUTTON_SIZE,
            action: ClickAction::CancelDictation,
        });
    }
}

fn draw_wrench_icon(ctx: &Ctx, x: f64, y: f64, size: f64, alpha: f64) {
    ctx.set_source_rgba(1.0, 1.0, 1.0, alpha);
    ctx.draw_symbol("wrench", x + size / 2.0, y + size / 2.0, size * 0.85);
}

// ── Text wrapping ─────────────────────────────────────────────────

fn wrap_text(ctx: &Ctx, text: &str, max_width: f64) -> Vec<String> {
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
            let extents = ctx.text_extents(&test);
            if extents.width > max_width && !current_line.is_empty() {
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
