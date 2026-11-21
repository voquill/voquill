use std::f64::consts::PI;

use gtk::cairo;

use crate::ipc::{Phase, PillPermission, PillStreaming};

use crate::constants::*;
use crate::state::{ClickAction, ClickRegion, PillState, RocketPhase};

pub(crate) fn draw_all(cr: &cairo::Context, state: &PillState) {
    cr.set_operator(cairo::Operator::Source);
    cr.set_source_rgba(0.0, 0.0, 0.0, 0.0);
    let _ = cr.paint();
    cr.set_operator(cairo::Operator::Over);

    state.click_regions.borrow_mut().clear();

    let ww = state.draw_width.get();
    let wh = state.draw_height.get();
    let (ox, oy) = state.content_offset();

    cr.save().ok();
    cr.translate(ox, oy);

    if state.assistant_active.get() || state.panel_open_t.get() > 0.01 {
        draw_assistant_panel(cr, state, ww, wh);
    } else if state.flash_t.get() < 0.01 {
        let pill_area_top = wh - PILL_AREA_HEIGHT;
        draw_tooltip(cr, state, ww, pill_area_top);
    }

    if !state.assistant_active.get() && state.flame_active.get() {
        draw_flame(cr, state, ww, wh);
    }

    draw_pill(cr, state, ww, wh);

    if state.flash_blue_active.get() {
        draw_flash_blue(cr, state, ww, wh);
    }

    if state.assistant_active.get() {
        draw_keyboard_button(cr, state, ww, wh);
    }

    if !state.assistant_active.get() {
        if !state.fireworks_rockets.borrow().is_empty() {
            draw_fireworks(cr, state, ww, wh);
        }

        if state.flash_t.get() > 0.01 {
            draw_flash_message(cr, state, ww, wh);
        }

        if state.transcript_opacity.get() > 0.001 {
            draw_broadcast_transcript(cr, state, ww, wh);
        }

        draw_cancel_button(cr, state, ww, wh);
    }

    cr.restore().ok();
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
        // Anchor to bottom: pill grows upward from a fixed bottom edge
        let bottom_offset = 6.0;
        wh - bottom_offset - pill_h
    };

    (pill_x, pill_y, pill_w, pill_h)
}

fn draw_pill(cr: &cairo::Context, state: &PillState, ww: f64, wh: f64) {
    let expand_t = state.expand_t.get();
    let (rx, ry, pill_w, pill_h) = pill_position(state, ww, wh);

    let bg_alpha = lerp(IDLE_BG_ALPHA, ACTIVE_BG_ALPHA, expand_t);
    let radius = lerp(COLLAPSED_RADIUS, EXPANDED_RADIUS, expand_t);

    let is_typing = state.assistant_active.get()
        && *state.assistant_input_mode.borrow() == "type";
    if is_typing {
        return;
    }

    rounded_rect(cr, rx, ry, pill_w, pill_h, radius);
    cr.set_source_rgba(0.0, 0.0, 0.0, bg_alpha);
    let _ = cr.fill();

    rounded_rect(cr, rx + 0.5, ry + 0.5, pill_w - 1.0, pill_h - 1.0, radius - 0.5);
    cr.set_source_rgba(1.0, 1.0, 1.0, BORDER_ALPHA);
    cr.set_line_width(1.0);
    let _ = cr.stroke();

    match state.phase.get() {
        Phase::Recording if expand_t > 0.1 => {
            draw_waveform(cr, rx, ry, pill_w, pill_h, expand_t, state);
            draw_edge_gradient(cr, rx, ry, pill_w, pill_h, radius, expand_t);
        }
        Phase::Loading if expand_t > 0.1 => {
            draw_loading(cr, rx, ry, pill_w, pill_h, radius, expand_t, state);
        }
        Phase::Idle if expand_t > 0.5 && (state.hovered.get() || state.assistant_active.get()) => {
            draw_idle_label(cr, rx, ry, pill_w, pill_h, expand_t);
        }
        _ => {}
    }

    state.click_regions.borrow_mut().push(ClickRegion {
        x: rx, y: ry, w: pill_w, h: pill_h,
        action: if state.assistant_active.get() { ClickAction::Pill } else { ClickAction::Pill },
    });
}

fn draw_waveform(
    cr: &cairo::Context, rx: f64, ry: f64, pill_w: f64, pill_h: f64,
    expand_t: f64, state: &PillState,
) {
    let wave_phase = state.wave_phase.get();
    let level = state.current_level.get();
    let baseline = ry + pill_h / 2.0;

    cr.save().ok();
    rounded_rect(cr, rx, ry, pill_w, pill_h, pill_h / 2.0);
    cr.clip();

    for config in WAVE_CONFIGS {
        let amplitude_factor = (level * config.multiplier).clamp(MIN_AMPLITUDE, MAX_AMPLITUDE);
        let amplitude = (pill_h * 0.75 * amplitude_factor).max(1.0);
        let phase = wave_phase + config.phase_offset;
        let alpha = config.opacity * expand_t;

        cr.set_source_rgba(1.0, 1.0, 1.0, alpha);
        cr.set_line_width(STROKE_WIDTH);
        cr.set_line_cap(cairo::LineCap::Round);
        cr.set_line_join(cairo::LineJoin::Round);

        let segments = (pill_w / 2.0).max(72.0) as i32;
        for i in 0..=segments {
            let t = i as f64 / segments as f64;
            let x = rx + pill_w * t;
            let theta = config.frequency * t * TAU + phase;
            let y = baseline + amplitude * theta.sin();

            if i == 0 {
                cr.move_to(x, y);
            } else {
                cr.line_to(x, y);
            }
        }
        let _ = cr.stroke();
    }

    cr.restore().ok();
}

fn draw_edge_gradient(
    cr: &cairo::Context, rx: f64, ry: f64, pill_w: f64, pill_h: f64,
    radius: f64, expand_t: f64,
) {
    cr.save().ok();
    rounded_rect(cr, rx, ry, pill_w, pill_h, radius);
    cr.clip();

    let alpha = 0.9 * expand_t;

    let left_grad = cairo::LinearGradient::new(rx, 0.0, rx + pill_w * 0.18, 0.0);
    left_grad.add_color_stop_rgba(0.0, 0.0, 0.0, 0.0, alpha);
    left_grad.add_color_stop_rgba(1.0, 0.0, 0.0, 0.0, 0.0);
    cr.set_source(&left_grad).ok();
    cr.rectangle(rx, ry, pill_w * 0.18, pill_h);
    let _ = cr.fill();

    let right_start = rx + pill_w * 0.85;
    let right_grad = cairo::LinearGradient::new(right_start, 0.0, rx + pill_w, 0.0);
    right_grad.add_color_stop_rgba(0.0, 0.0, 0.0, 0.0, 0.0);
    right_grad.add_color_stop_rgba(1.0, 0.0, 0.0, 0.0, alpha);
    cr.set_source(&right_grad).ok();
    cr.rectangle(right_start, ry, pill_w * 0.15, pill_h);
    let _ = cr.fill();

    cr.restore().ok();
}

fn draw_loading(
    cr: &cairo::Context, rx: f64, ry: f64, pill_w: f64, pill_h: f64,
    radius: f64, expand_t: f64, state: &PillState,
) {
    cr.save().ok();
    rounded_rect(cr, rx, ry, pill_w, pill_h, radius);
    cr.clip();

    let bar_h = 2.0;
    let bar_y = ry + (pill_h - bar_h) / 2.0;
    let pad = pill_h * 0.1;
    let track_x = rx + pad;
    let track_w = pill_w - pad * 2.0;

    // Track line
    cr.set_source_rgba(1.0, 1.0, 1.0, 0.15 * expand_t);
    cr.rectangle(track_x, bar_y, track_w, bar_h);
    let _ = cr.fill();

    // Moving indicator
    let indicator_w = track_w * LOADING_BAR_WIDTH_FRAC;
    let offset = state.loading_offset.get();
    let ind_x = track_x + (track_w + indicator_w) * offset - indicator_w;

    let draw_left = ind_x.max(track_x);
    let draw_right = (ind_x + indicator_w).min(track_x + track_w);
    if draw_right > draw_left {
        cr.set_source_rgba(1.0, 1.0, 1.0, 0.7 * expand_t);
        cr.rectangle(draw_left, bar_y, draw_right - draw_left, bar_h);
        let _ = cr.fill();
    }

    cr.restore().ok();

    draw_edge_gradient(cr, rx, ry, pill_w, pill_h, radius, expand_t);
}

fn draw_idle_label(cr: &cairo::Context, rx: f64, ry: f64, pill_w: f64, pill_h: f64, expand_t: f64) {
    cr.set_source_rgba(1.0, 1.0, 1.0, 0.4 * expand_t);
    cr.select_font_face("sans-serif", cairo::FontSlant::Normal, cairo::FontWeight::Bold);
    cr.set_font_size(11.0);
    let text = "Click to dictate";
    let extents = cr.text_extents(text).unwrap();
    let tx = rx + (pill_w - extents.width()) / 2.0 - extents.x_bearing();
    let ty = ry + (pill_h - extents.height()) / 2.0 - extents.y_bearing();
    cr.move_to(tx, ty);
    let _ = cr.show_text(text);
}

// ── Tooltip (dictation style selector) ────────────────────────────

fn draw_tooltip(cr: &cairo::Context, state: &PillState, ww: f64, pill_area_top: f64) {
    let tooltip_t = state.tooltip_t.get();
    if tooltip_t < 0.01 {
        return;
    }

    let style_name = state.style_name.borrow();
    if state.style_count.get() <= 1 || style_name.is_empty() {
        return;
    }

    cr.select_font_face("sans-serif", cairo::FontSlant::Normal, cairo::FontWeight::Bold);
    cr.set_font_size(11.0);
    let text_extents = cr.text_extents(&style_name).unwrap();
    let text_w = text_extents.width().clamp(20.0, 100.0);

    let chevron_area = 20.0;
    let padding_h = 10.0;
    let tooltip_w = padding_h * 2.0 + chevron_area * 2.0 + text_w;
    state.tooltip_width.set(tooltip_w);

    let tooltip_rx = (ww - tooltip_w) / 2.0;
    let y_offset = (1.0 - tooltip_t) * 4.0;
    let tooltip_ry = pill_area_top - TOOLTIP_GAP - TOOLTIP_HEIGHT + y_offset;
    let alpha = tooltip_t;

    rounded_rect(cr, tooltip_rx, tooltip_ry, tooltip_w, TOOLTIP_HEIGHT, TOOLTIP_RADIUS);
    cr.set_source_rgba(0.0, 0.0, 0.0, 0.92 * alpha);
    let _ = cr.fill();

    rounded_rect(cr, tooltip_rx + 0.5, tooltip_ry + 0.5, tooltip_w - 1.0, TOOLTIP_HEIGHT - 1.0, TOOLTIP_RADIUS - 0.5);
    cr.set_source_rgba(1.0, 1.0, 1.0, 0.2 * alpha);
    cr.set_line_width(1.0);
    let _ = cr.stroke();

    let center_y = tooltip_ry + TOOLTIP_HEIGHT / 2.0;

    // Left chevron
    let left_cx = tooltip_rx + padding_h + 5.0;
    cr.set_source_rgba(1.0, 1.0, 1.0, 0.8 * alpha);
    cr.set_line_width(1.5);
    cr.set_line_cap(cairo::LineCap::Round);
    cr.set_line_join(cairo::LineJoin::Round);
    cr.move_to(left_cx + 3.0, center_y - 4.0);
    cr.line_to(left_cx - 3.0, center_y);
    cr.line_to(left_cx + 3.0, center_y + 4.0);
    let _ = cr.stroke();

    // Right chevron
    let right_cx = tooltip_rx + tooltip_w - padding_h - 5.0;
    cr.set_source_rgba(1.0, 1.0, 1.0, 0.8 * alpha);
    cr.set_line_width(1.5);
    cr.set_line_cap(cairo::LineCap::Round);
    cr.set_line_join(cairo::LineJoin::Round);
    cr.move_to(right_cx - 3.0, center_y - 4.0);
    cr.line_to(right_cx + 3.0, center_y);
    cr.line_to(right_cx - 3.0, center_y + 4.0);
    let _ = cr.stroke();

    // Style name text
    cr.set_source_rgba(1.0, 1.0, 1.0, 0.9 * alpha);
    cr.select_font_face("sans-serif", cairo::FontSlant::Normal, cairo::FontWeight::Bold);
    cr.set_font_size(11.0);
    let text_area_left = tooltip_rx + padding_h + chevron_area;
    let text_area_right = tooltip_rx + tooltip_w - padding_h - chevron_area;
    let text_area_center = (text_area_left + text_area_right) / 2.0;
    let tx = text_area_center - text_extents.width() / 2.0 - text_extents.x_bearing();
    let ty = center_y - text_extents.height() / 2.0 - text_extents.y_bearing();

    cr.save().ok();
    cr.rectangle(text_area_left, tooltip_ry, text_area_right - text_area_left, TOOLTIP_HEIGHT);
    cr.clip();
    cr.move_to(tx, ty);
    let _ = cr.show_text(&style_name);
    cr.restore().ok();

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

fn draw_flash_message(cr: &cairo::Context, state: &PillState, ww: f64, wh: f64) {
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

    let layout = pangocairo::functions::create_layout(cr);
    let font_desc = pango::FontDescription::from_string("sans bold 12");
    layout.set_font_description(Some(&font_desc));
    layout.set_text(&message);
    let (text_w, text_h) = layout.pixel_size();
    let text_w = text_w as f64;
    let text_h = text_h as f64;

    let (action_w, action_layout) = if let Some(ref label) = *action_label {
        let al = pangocairo::functions::create_layout(cr);
        let af = pango::FontDescription::from_string("sans bold 11");
        al.set_font_description(Some(&af));
        al.set_text(label);
        let (aw, _) = al.pixel_size();
        (aw as f64 + FLASH_ACTION_PADDING_H * 2.0, Some(al))
    } else {
        (0.0, None)
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

    cr.save().ok();
    cr.translate(center_x, center_y);
    cr.scale(scale, scale);
    cr.translate(-center_x, -center_y);

    // Background
    let (bg_r, bg_g, bg_b) = if is_error { (0.35, 0.05, 0.05) } else { (0.0, 0.0, 0.0) };
    rounded_rect(cr, full_x, full_y, flash_w, FLASH_HEIGHT, FLASH_RADIUS);
    cr.set_source_rgba(bg_r, bg_g, bg_b, 0.92 * alpha);
    let _ = cr.fill();

    // Message text
    cr.set_source_rgba(1.0, 1.0, 1.0, 0.9 * alpha);
    let text_left = if has_action {
        full_x + FLASH_PADDING_H
    } else {
        full_x + (flash_w - text_w) / 2.0
    };
    let ty = full_y + (FLASH_HEIGHT - text_h) / 2.0;
    cr.move_to(text_left, ty);
    pangocairo::functions::show_layout(cr, &layout);

    // Action button
    if let Some(al) = action_layout {
        let btn_x = full_x + flash_w - FLASH_PADDING_H - action_w;
        let btn_y = full_y + (FLASH_HEIGHT - FLASH_ACTION_HEIGHT) / 2.0;

        rounded_rect(cr, btn_x, btn_y, action_w, FLASH_ACTION_HEIGHT, FLASH_ACTION_RADIUS);
        cr.set_source_rgba(1.0, 1.0, 1.0, 0.2 * alpha);
        let _ = cr.fill();

        cr.set_source_rgba(1.0, 1.0, 1.0, 0.95 * alpha);
        let (lw, lh) = al.pixel_size();
        let lx = btn_x + (action_w - lw as f64) / 2.0;
        let ly = btn_y + (FLASH_ACTION_HEIGHT - lh as f64) / 2.0;
        cr.move_to(lx, ly);
        pangocairo::functions::show_layout(cr, &al);

        state.click_regions.borrow_mut().push(ClickRegion {
            x: btn_x,
            y: btn_y,
            w: action_w,
            h: FLASH_ACTION_HEIGHT,
            action: ClickAction::FlashAction,
        });
    }

    cr.restore().ok();
}

// ── Flame ────────────────────────────────────────────────────────

fn draw_flame_tongue(
    cr: &cairo::Context, cx: f64, base_y: f64, h: f64, hw: f64, sway: f64,
    gradient_stops: &[(f64, f64, f64, f64, f64)],
) {
    let tip_x = cx + sway;
    let tip_y = base_y - h;
    let base_r = hw.min(h * 0.15);

    cr.save().ok();
    cr.new_sub_path();
    cr.move_to(cx - hw, base_y - base_r);
    cr.curve_to(
        cx - hw * 1.15, base_y - h * 0.35,
        cx - hw * 0.12 + sway * 0.3, base_y - h * 0.72,
        tip_x, tip_y,
    );
    cr.curve_to(
        cx + hw * 0.12 + sway * 0.3, base_y - h * 0.72,
        cx + hw * 1.15, base_y - h * 0.35,
        cx + hw, base_y - base_r,
    );
    cr.arc(cx, base_y - base_r, hw, 0.0, PI);
    cr.close_path();
    cr.clip();

    let gradient = cairo::LinearGradient::new(cx, base_y, cx, tip_y);
    for &(offset, r, g, b, a) in gradient_stops {
        gradient.add_color_stop_rgba(offset, r, g, b, a);
    }
    cr.set_source(&gradient).ok();
    let _ = cr.paint();

    cr.restore().ok();
}

fn draw_flame(cr: &cairo::Context, state: &PillState, ww: f64, wh: f64) {
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

        draw_flame_tongue(cr, cx, base_y, h * 1.2, hw * 1.5, sway * 1.1,
            &[
                (0.0, 0.7, 0.7, 0.7, alpha * 0.15),
                (0.4, 0.4, 0.4, 0.4, alpha * 0.08),
                (1.0, 0.0, 0.0, 0.0, 0.0),
            ],
        );

        draw_flame_tongue(cr, cx, base_y, h, hw, sway,
            &[
                (0.0, 1.0, 1.0, 1.0, alpha * 0.85),
                (0.25, 1.0, 1.0, 1.0, alpha * 0.65),
                (0.55, 0.8, 0.8, 0.8, alpha * 0.3),
                (1.0, 0.0, 0.0, 0.0, 0.0),
            ],
        );

        draw_flame_tongue(cr, cx, base_y, h * 0.55, hw * 0.35, sway * 0.5,
            &[
                (0.0, 1.0, 1.0, 1.0, alpha * 0.95),
                (0.5, 1.0, 1.0, 1.0, alpha * 0.5),
                (1.0, 1.0, 1.0, 1.0, 0.0),
            ],
        );
    }
}

// ── Fireworks ────────────────────────────────────────────────────

fn draw_fireworks(cr: &cairo::Context, state: &PillState, _ww: f64, _wh: f64) {
    let rockets = state.fireworks_rockets.borrow();

    for rocket in rockets.iter() {
        let (rc, gc, bc) = rocket.color;

        // Trail
        if rocket.trail.len() > 1 && rocket.trail_alpha > 0.01 {
            let n = rocket.trail.len();
            cr.set_line_width(FIREWORKS_ROCKET_LINE_WIDTH);
            cr.set_line_cap(cairo::LineCap::Round);
            for i in 1..n {
                let alpha = (i as f64 / n as f64) * rocket.trail_alpha * 0.8;
                cr.set_source_rgba(rc, gc, bc, alpha);
                cr.move_to(rocket.trail[i - 1].0, rocket.trail[i - 1].1);
                cr.line_to(rocket.trail[i].0, rocket.trail[i].1);
                let _ = cr.stroke();
            }
        }

        // Bright head while rising
        if rocket.phase == RocketPhase::Rising {
            let hs = FIREWORKS_HEAD_SIZE / 2.0;
            cr.set_source_rgba(rc, gc, bc, 0.95);
            rounded_rect(cr, rocket.x - hs, rocket.y - hs, FIREWORKS_HEAD_SIZE, FIREWORKS_HEAD_SIZE, hs);
            let _ = cr.fill();
        }

        // Sparks
        cr.set_line_width(FIREWORKS_SPARK_LINE_WIDTH);
        cr.set_line_cap(cairo::LineCap::Round);
        for spark in &rocket.sparks {
            if spark.life <= 0.0 {
                continue;
            }
            let alpha = spark.life.clamp(0.0, 1.0) * 0.9;
            cr.set_source_rgba(rc, gc, bc, alpha);

            let speed = (spark.vx * spark.vx + spark.vy * spark.vy).sqrt();
            let line_len = (speed * 0.04).clamp(2.0, 10.0);
            let (nx, ny) = if speed > 0.01 {
                (spark.vx / speed, spark.vy / speed)
            } else {
                (0.0, -1.0)
            };

            cr.move_to(spark.x - nx * line_len, spark.y - ny * line_len);
            cr.line_to(spark.x, spark.y);
            let _ = cr.stroke();
        }
    }
}

// ── Assistant panel ───────────────────────────────────────────────

fn draw_assistant_panel(cr: &cairo::Context, state: &PillState, ww: f64, wh: f64) {
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
    cr.save().ok();
    rounded_rect(cr, panel_x, panel_y + y_shift, panel_w, panel_h, PANEL_RADIUS);
    cr.set_source_rgba(0.0, 0.0, 0.0, PANEL_BG_ALPHA * alpha);
    let _ = cr.fill();

    rounded_rect(cr, panel_x + 0.5, panel_y + y_shift + 0.5, panel_w - 1.0, panel_h - 1.0, PANEL_RADIUS - 0.5);
    cr.set_source_rgba(1.0, 1.0, 1.0, PANEL_BORDER_ALPHA * alpha);
    cr.set_line_width(1.0);
    let _ = cr.stroke();
    cr.restore().ok();

    let py = panel_y + y_shift;

    let pill_top_in_panel = panel_h - PILL_BOTTOM_INSET - EXPANDED_PILL_HEIGHT;

    if is_compact {
        draw_compact_content(cr, panel_x, py, panel_w, pill_top_in_panel, alpha, state);
    } else {
        cr.save().ok();
        rounded_rect(cr, panel_x, py, panel_w, panel_h, PANEL_RADIUS);
        cr.clip();

        let content_x = panel_x + PANEL_CONTENT_SIDE_INSET;
        let content_w = panel_w - PANEL_CONTENT_SIDE_INSET * 2.0;

        // Scroll view spans the full panel height (minus input bar if typing).
        // Header, pill, and input are layered on top.
        let scroll_bottom = if is_typing {
            py + panel_h - PANEL_INPUT_HEIGHT
        } else {
            py + panel_h
        };
        let scroll_h = (scroll_bottom - py).max(0.0);
        state.viewport_height.set(scroll_h);

        // Content padding clears the header area at top and pill/input at bottom
        let top_pad = PANEL_TRANSCRIPT_TOP_OFFSET + SCROLL_TOP_PAD;
        let bottom_pad = if is_typing {
            SCROLL_BOTTOM_PAD
        } else {
            PILL_BOTTOM_INSET + EXPANDED_PILL_HEIGHT + SCROLL_BOTTOM_PAD
        };

        draw_transcript(cr, state, content_x, py, content_w, scroll_h, alpha, top_pad, bottom_pad);

        // Top gradient: opaque over header area, fades into content
        let grad_h = PANEL_TRANSCRIPT_TOP_OFFSET + 16.0;
        let top_grad = cairo::LinearGradient::new(0.0, py, 0.0, py + grad_h);
        top_grad.add_color_stop_rgba(0.0, 0.0, 0.0, 0.0, 0.98 * alpha);
        top_grad.add_color_stop_rgba(0.38, 0.0, 0.0, 0.0, 0.82 * alpha);
        top_grad.add_color_stop_rgba(1.0, 0.0, 0.0, 0.0, 0.0);
        cr.set_source(&top_grad).ok();
        cr.rectangle(panel_x, py, panel_w, grad_h);
        let _ = cr.fill();

        // Bottom gradient: opaque over pill/bottom area, fades into content
        let bot_area = if is_typing { 0.0 } else { PILL_BOTTOM_INSET + EXPANDED_PILL_HEIGHT };
        let bot_grad_h = bot_area + 16.0;
        let bot_y = scroll_bottom - bot_grad_h;
        let bot_grad = cairo::LinearGradient::new(0.0, bot_y, 0.0, scroll_bottom);
        bot_grad.add_color_stop_rgba(0.0, 0.0, 0.0, 0.0, 0.0);
        bot_grad.add_color_stop_rgba(0.28, 0.0, 0.0, 0.0, 0.82 * alpha);
        bot_grad.add_color_stop_rgba(1.0, 0.0, 0.0, 0.0, 0.98 * alpha);
        cr.set_source(&bot_grad).ok();
        cr.rectangle(panel_x, bot_y, panel_w, bot_grad_h);
        let _ = cr.fill();

        cr.restore().ok();

        // Header elements drawn on top of gradients (matching React zIndex: 3)
        if let Some(ref prompt) = *state.assistant_user_prompt.borrow() {
            draw_user_prompt_preview(cr, panel_x, py, panel_w, prompt, alpha);
        }

        // Input bar drawn on top of scroll view + gradients
        if is_typing {
            let input_y = py + panel_h - PANEL_INPUT_HEIGHT;
            cr.set_source_rgba(1.0, 1.0, 1.0, 0.1 * alpha);
            cr.set_line_width(1.0);
            cr.move_to(panel_x + PANEL_CONTENT_SIDE_INSET, input_y);
            cr.line_to(panel_x + panel_w - PANEL_CONTENT_SIDE_INSET, input_y);
            let _ = cr.stroke();

            // Send button
            let send_btn_size = 28.0;
            let send_x = panel_x + panel_w - PANEL_CONTENT_SIDE_INSET - send_btn_size;
            let send_y = input_y + (PANEL_INPUT_HEIGHT - send_btn_size) / 2.0;
            let has_text = !state.entry_text.borrow().trim().is_empty();
            let text_alpha = if has_text { 0.82 } else { 0.2 };

            cr.set_source_rgba(1.0, 1.0, 1.0, text_alpha * alpha);
            let cx = send_x + send_btn_size / 2.0;
            let cy = send_y + send_btn_size / 2.0;
            cr.set_line_width(1.5);
            cr.set_line_cap(cairo::LineCap::Round);
            cr.set_line_join(cairo::LineJoin::Round);
            cr.move_to(cx - 5.0, cy + 5.0);
            cr.line_to(cx + 5.0, cy);
            cr.line_to(cx - 5.0, cy - 5.0);
            let _ = cr.stroke();
            cr.move_to(cx - 5.0, cy);
            cr.line_to(cx + 5.0, cy);
            let _ = cr.stroke();

            if has_text {
                state.click_regions.borrow_mut().push(ClickRegion {
                    x: send_x, y: send_y, w: send_btn_size, h: send_btn_size,
                    action: ClickAction::SendButton,
                });
            }
        }
    }

    // Close button drawn last so it's always on top of gradients
    draw_close_button(cr, panel_x + PANEL_HEADER_OFFSET_LEFT, py + PANEL_HEADER_OFFSET_TOP,
        HEADER_BUTTON_SIZE, alpha);
    state.click_regions.borrow_mut().push(ClickRegion {
        x: panel_x + PANEL_HEADER_OFFSET_LEFT,
        y: py + PANEL_HEADER_OFFSET_TOP,
        w: HEADER_BUTTON_SIZE, h: HEADER_BUTTON_SIZE,
        action: ClickAction::AssistantClose,
    });
}

fn draw_compact_content(
    cr: &cairo::Context, panel_x: f64, panel_y: f64, panel_w: f64,
    content_height: f64, alpha: f64, state: &PillState,
) {
    let text = "What can I help you with?";
    let text_alpha = if state.phase.get() == Phase::Recording { 0.96 } else { 0.8 };
    cr.set_source_rgba(1.0, 1.0, 1.0, text_alpha * alpha);
    cr.select_font_face("sans-serif", cairo::FontSlant::Normal, cairo::FontWeight::Normal);
    cr.set_font_size(18.0);
    let extents = cr.text_extents(text).unwrap();
    let tx = panel_x + (panel_w - extents.width()) / 2.0 - extents.x_bearing();
    let ty = panel_y + (content_height - extents.height()) / 2.0 - extents.y_bearing();
    cr.move_to(tx, ty);
    let _ = cr.show_text(text);
}

fn draw_transcript(
    cr: &cairo::Context, state: &PillState,
    area_x: f64, area_y: f64, area_w: f64, area_h: f64, alpha: f64,
    top_pad: f64, bottom_pad: f64,
) {
    let messages = state.assistant_messages.borrow();
    let streaming = state.assistant_streaming.borrow();
    let permissions = state.assistant_permissions.borrow();

    if messages.is_empty() && permissions.is_empty() {
        return;
    }

    cr.save().ok();
    cr.rectangle(area_x, area_y, area_w, area_h);
    cr.clip();

    let scroll = state.scroll_offset.get();
    let mut y = area_y + top_pad - scroll;

    cr.select_font_face("sans-serif", cairo::FontSlant::Normal, cairo::FontWeight::Normal);
    cr.set_font_size(14.0);

    let line_height = 20.0;

    for (i, msg) in messages.iter().enumerate() {
        if i > 0 {
            y += 16.0;
            cr.set_source_rgba(1.0, 1.0, 1.0, 0.45 * alpha);
            cr.set_line_width(1.0);
            cr.move_to(area_x, y);
            cr.line_to(area_x + 36.0, y);
            let _ = cr.stroke();
            y += 8.0;
        }

        if let Some(ref stream) = *streaming {
            if stream.message_id == msg.id {
                y = draw_streaming_activity(cr, stream, area_x, y, area_w, alpha);
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

            cr.set_source_rgba(1.0, 1.0, 1.0, 0.5 * alpha);
            cr.select_font_face("sans-serif", cairo::FontSlant::Normal, cairo::FontWeight::Normal);
            cr.set_font_size(12.0);

            draw_wrench_icon(cr, area_x, y + 2.0, 12.0, 0.5 * alpha);
            let text_x = area_x + 18.0;
            cr.move_to(text_x, y + 12.0);
            let _ = cr.show_text(&display);
            y += 18.0;
        } else if let Some(ref content) = msg.content {
            let color_alpha = if msg.is_error { 0.94 } else { 0.92 };
            let (r, g, b) = if msg.is_error { (1.0, 0.4, 0.4) } else { (1.0, 1.0, 1.0) };

            cr.set_source_rgba(r, g, b, color_alpha * alpha);
            cr.select_font_face("sans-serif", cairo::FontSlant::Normal, cairo::FontWeight::Normal);
            cr.set_font_size(14.0);

            let lines = wrap_text(cr, content, area_w);
            for line in &lines {
                cr.move_to(area_x, y + line_height * 0.75);
                let _ = cr.show_text(line);
                y += line_height;
            }
        } else {
            y = draw_thinking_text(cr, area_x, y, alpha, state);
        }
    }

    for perm in permissions.iter() {
        y += 12.0;
        y = draw_permission_card(cr, state, perm, area_x, y, area_w, alpha);
    }

    let total_height = y + scroll - area_y + bottom_pad;
    state.content_height.set(total_height);

    cr.restore().ok();
}

fn draw_streaming_activity(
    cr: &cairo::Context, streaming: &PillStreaming,
    x: f64, mut y: f64, _w: f64, alpha: f64,
) -> f64 {
    cr.select_font_face("sans-serif", cairo::FontSlant::Italic, cairo::FontWeight::Normal);
    cr.set_font_size(12.0);
    cr.set_source_rgba(1.0, 1.0, 1.0, 0.5 * alpha);

    for tc in &streaming.tool_calls {
        let text = if tc.done {
            format!("Used {}", tc.name)
        } else {
            format!("Using {}…", tc.name)
        };
        cr.move_to(x, y + 12.0);
        let _ = cr.show_text(&text);
        y += 16.0;
    }

    if !streaming.reasoning.is_empty() {
        let label = if streaming.is_streaming { "Thinking…" } else { "Thought process" };
        cr.move_to(x, y + 12.0);
        let _ = cr.show_text(label);
        y += 16.0;
    }

    y
}

fn draw_thinking_text(
    cr: &cairo::Context, x: f64, y: f64, alpha: f64, state: &PillState,
) -> f64 {
    let text = "Thinking";
    cr.select_font_face("sans-serif", cairo::FontSlant::Normal, cairo::FontWeight::Normal);
    cr.set_font_size(14.0);
    let extents = cr.text_extents(text).unwrap();

    let shimmer = state.shimmer_phase.get();
    let text_y = y + 14.0;

    cr.save().ok();
    cr.rectangle(x, y, extents.width() + 4.0, 20.0);
    cr.clip();

    let grad_offset = shimmer * extents.width() * 4.0 - extents.width();
    let gradient = cairo::LinearGradient::new(x + grad_offset, 0.0, x + grad_offset + extents.width() * 2.0, 0.0);
    gradient.add_color_stop_rgba(0.0, 1.0, 1.0, 1.0, 0.34 * alpha);
    gradient.add_color_stop_rgba(0.5, 1.0, 1.0, 1.0, 0.92 * alpha);
    gradient.add_color_stop_rgba(1.0, 1.0, 1.0, 1.0, 0.34 * alpha);
    cr.set_source(&gradient).ok();
    cr.move_to(x, text_y);
    let _ = cr.show_text(text);

    cr.restore().ok();
    y + 20.0
}

fn draw_permission_card(
    cr: &cairo::Context, state: &PillState, perm: &PillPermission,
    x: f64, y: f64, w: f64, alpha: f64,
) -> f64 {
    let card_h = PERM_CARD_HEIGHT;

    rounded_rect(cr, x, y, w, card_h, 12.0);
    cr.set_source_rgba(1.0, 1.0, 1.0, 0.06 * alpha);
    let _ = cr.fill();

    rounded_rect(cr, x + 0.5, y + 0.5, w - 1.0, card_h - 1.0, 11.5);
    cr.set_source_rgba(1.0, 1.0, 1.0, 0.12 * alpha);
    cr.set_line_width(1.0);
    let _ = cr.stroke();

    let tool_label = perm.description.as_deref().unwrap_or(&perm.tool_name);
    cr.set_source_rgba(1.0, 1.0, 1.0, 0.82 * alpha);
    cr.select_font_face("sans-serif", cairo::FontSlant::Normal, cairo::FontWeight::Bold);
    cr.set_font_size(12.0);
    cr.move_to(x + 12.0, y + 18.0);
    let _ = cr.show_text(tool_label);

    if let Some(ref reason) = perm.reason {
        cr.set_source_rgba(1.0, 1.0, 1.0, 0.5 * alpha);
        cr.select_font_face("sans-serif", cairo::FontSlant::Normal, cairo::FontWeight::Normal);
        cr.set_font_size(11.0);
        cr.move_to(x + 12.0, y + 32.0);
        let _ = cr.show_text(reason);
    }

    let btn_y = y + card_h - PERM_BUTTON_HEIGHT - 8.0;
    let btn_labels = [("Deny", 0.5), ("Allow", 0.82), ("Always Allow", 0.82)];
    let mut btn_x = x + w - 12.0;

    for (i, (label, text_alpha)) in btn_labels.iter().rev().enumerate() {
        let btn_w = if i == 0 { PERM_BUTTON_WIDTH + 16.0 } else { PERM_BUTTON_WIDTH };
        btn_x -= btn_w;

        rounded_rect(cr, btn_x, btn_y, btn_w, PERM_BUTTON_HEIGHT, 6.0);
        cr.set_source_rgba(1.0, 1.0, 1.0, 0.08 * alpha);
        let _ = cr.fill();

        rounded_rect(cr, btn_x + 0.5, btn_y + 0.5, btn_w - 1.0, PERM_BUTTON_HEIGHT - 1.0, 5.5);
        cr.set_source_rgba(1.0, 1.0, 1.0, 0.15 * alpha);
        cr.set_line_width(1.0);
        let _ = cr.stroke();

        cr.set_source_rgba(1.0, 1.0, 1.0, text_alpha * alpha);
        cr.select_font_face("sans-serif", cairo::FontSlant::Normal, cairo::FontWeight::Normal);
        cr.set_font_size(11.0);
        let ext = cr.text_extents(label).unwrap();
        cr.move_to(btn_x + (btn_w - ext.width()) / 2.0 - ext.x_bearing(), btn_y + (PERM_BUTTON_HEIGHT - ext.height()) / 2.0 - ext.y_bearing());
        let _ = cr.show_text(label);

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
    cr: &cairo::Context, panel_x: f64, panel_y: f64, panel_w: f64,
    prompt: &str, alpha: f64,
) {
    cr.set_source_rgba(1.0, 1.0, 1.0, 0.5 * alpha);
    cr.select_font_face("sans-serif", cairo::FontSlant::Normal, cairo::FontWeight::Normal);
    cr.set_font_size(14.0);

    let max_w = panel_w * 0.5;
    let mut display = prompt.to_string();
    loop {
        let ext = cr.text_extents(&display).unwrap();
        if ext.width() <= max_w || display.len() < 4 {
            break;
        }
        display.truncate(display.len() - 4);
        display.push_str("…");
    }

    let ext = cr.text_extents(&display).unwrap();
    let tx = panel_x + panel_w - PANEL_HEADER_OFFSET_RIGHT - ext.width() - ext.x_bearing();
    let ty = panel_y + PANEL_HEADER_OFFSET_TOP + HEADER_BUTTON_SIZE / 2.0 - ext.height() / 2.0 - ext.y_bearing();
    cr.move_to(tx, ty);
    let _ = cr.show_text(&display);
}

fn draw_close_button(cr: &cairo::Context, x: f64, y: f64, size: f64, alpha: f64) {
    rounded_rect(cr, x, y, size, size, size / 4.0);
    cr.set_source_rgba(1.0, 1.0, 1.0, 0.06 * alpha);
    let _ = cr.fill();

    let cx = x + size / 2.0;
    let cy = y + size / 2.0;
    let icon_size = 7.0;

    cr.set_source_rgba(1.0, 1.0, 1.0, 0.82 * alpha);
    cr.set_line_width(1.5);
    cr.set_line_cap(cairo::LineCap::Round);
    cr.move_to(cx - icon_size / 2.0, cy - icon_size / 2.0);
    cr.line_to(cx + icon_size / 2.0, cy + icon_size / 2.0);
    let _ = cr.stroke();
    cr.move_to(cx + icon_size / 2.0, cy - icon_size / 2.0);
    cr.line_to(cx - icon_size / 2.0, cy + icon_size / 2.0);
    let _ = cr.stroke();
}

fn draw_keyboard_button(cr: &cairo::Context, state: &PillState, ww: f64, wh: f64) {
    let kb_t = state.kb_button_t.get();
    if kb_t < 0.01 {
        return;
    }

    let (_, pill_y, _, _) = pill_position(state, ww, wh);
    let pill_center_x = ww / 2.0;

    let target_x = pill_center_x + EXPANDED_PILL_WIDTH / 2.0 + KB_BUTTON_GAP;
    let hidden_x = pill_center_x - KB_BUTTON_SIZE / 2.0;
    let btn_x = lerp(hidden_x, target_x, kb_t);
    let btn_y = pill_y + (EXPANDED_PILL_HEIGHT - KB_BUTTON_SIZE) / 2.0;
    let scale = lerp(0.5, 1.0, kb_t);
    let alpha = kb_t;

    cr.save().ok();
    cr.translate(btn_x + KB_BUTTON_SIZE / 2.0, btn_y + KB_BUTTON_SIZE / 2.0);
    cr.scale(scale, scale);
    cr.translate(-(KB_BUTTON_SIZE / 2.0), -(KB_BUTTON_SIZE / 2.0));

    cr.arc(KB_BUTTON_SIZE / 2.0, KB_BUTTON_SIZE / 2.0, KB_BUTTON_SIZE / 2.0, 0.0, TAU);
    cr.set_source_rgba(0.0, 0.0, 0.0, 0.92 * alpha);
    let _ = cr.fill();

    cr.arc(KB_BUTTON_SIZE / 2.0, KB_BUTTON_SIZE / 2.0, KB_BUTTON_SIZE / 2.0 - 0.5, 0.0, TAU);
    cr.set_source_rgba(1.0, 1.0, 1.0, BORDER_ALPHA * alpha);
    cr.set_line_width(1.0);
    let _ = cr.stroke();

    let cx = KB_BUTTON_SIZE / 2.0;
    let cy = KB_BUTTON_SIZE / 2.0;
    let kw = 12.0;
    let kh = 8.0;
    let kx = cx - kw / 2.0;
    let ky = cy - kh / 2.0;

    rounded_rect(cr, kx, ky, kw, kh, 1.5);
    cr.set_source_rgba(1.0, 1.0, 1.0, 0.7 * alpha);
    cr.set_line_width(1.0);
    let _ = cr.stroke();

    cr.set_source_rgba(1.0, 1.0, 1.0, 0.7 * alpha);
    for row in 0..2 {
        let dots = if row == 0 { 3 } else { 2 };
        let row_y = ky + 2.5 + row as f64 * 3.5;
        let total_w = (dots - 1) as f64 * 3.0;
        let start_x = cx - total_w / 2.0;
        for d in 0..dots {
            let dx = start_x + d as f64 * 3.0;
            cr.rectangle(dx - 0.5, row_y - 0.5, 1.0, 1.0);
            let _ = cr.fill();
        }
    }

    cr.restore().ok();

    if kb_t > 0.5 {
        state.click_regions.borrow_mut().push(ClickRegion {
            x: btn_x, y: btn_y, w: KB_BUTTON_SIZE, h: KB_BUTTON_SIZE,
            action: ClickAction::KeyboardButton,
        });
    }
}

fn draw_cancel_button(cr: &cairo::Context, state: &PillState, ww: f64, wh: f64) {
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
    cr.save().ok();
    cr.translate(cx, cy);
    cr.scale(scale, scale);
    cr.translate(-cx, -cy);

    cr.arc(cx, cy, CANCEL_BUTTON_SIZE / 2.0, 0.0, TAU);
    cr.set_source_rgba(0.46, 0.46, 0.46, t);
    let _ = cr.fill();

    let s = 3.5;
    cr.set_source_rgba(1.0, 1.0, 1.0, t);
    cr.set_line_width(1.5);
    cr.set_line_cap(cairo::LineCap::Round);
    cr.move_to(cx - s, cy - s);
    cr.line_to(cx + s, cy + s);
    let _ = cr.stroke();
    cr.move_to(cx + s, cy - s);
    cr.line_to(cx - s, cy + s);
    let _ = cr.stroke();

    cr.restore().ok();

    if t > 0.5 {
        state.click_regions.borrow_mut().push(ClickRegion {
            x: btn_x, y: btn_y, w: CANCEL_BUTTON_SIZE, h: CANCEL_BUTTON_SIZE,
            action: ClickAction::CancelDictation,
        });
    }
}

fn draw_wrench_icon(cr: &cairo::Context, x: f64, y: f64, size: f64, alpha: f64) {
    cr.set_source_rgba(1.0, 1.0, 1.0, alpha);
    cr.set_line_width(1.0);
    cr.set_line_cap(cairo::LineCap::Round);
    let cx = x + size / 2.0;
    let cy = y + size / 2.0;
    let r = size * 0.35;
    cr.arc(cx, cy, r, 0.0, TAU);
    let _ = cr.stroke();
    cr.move_to(cx + r * 0.7, cy + r * 0.7);
    cr.line_to(cx + size * 0.4, cy + size * 0.4);
    let _ = cr.stroke();
}

// ── Text wrapping ─────────────────────────────────────────────────

fn wrap_text(cr: &cairo::Context, text: &str, max_width: f64) -> Vec<String> {
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
            if let Ok(extents) = cr.text_extents(&test) {
                if extents.width() > max_width && !current_line.is_empty() {
                    lines.push(current_line);
                    current_line = word.to_string();
                } else {
                    current_line = test;
                }
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

// ── Utility ───────────────────────────────────────────────────────

fn rounded_rect(cr: &cairo::Context, x: f64, y: f64, w: f64, h: f64, r: f64) {
    let r = r.min(w / 2.0).min(h / 2.0);
    cr.new_sub_path();
    cr.arc(x + w - r, y + r, r, -PI / 2.0, 0.0);
    cr.arc(x + w - r, y + h - r, r, 0.0, PI / 2.0);
    cr.arc(x + r, y + h - r, r, PI / 2.0, PI);
    cr.arc(x + r, y + r, r, PI, 3.0 * PI / 2.0);
    cr.close_path();
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

// ── Flash blue border ────────────────────────────────────────────

fn draw_flash_blue(cr: &cairo::Context, state: &PillState, ww: f64, wh: f64) {
    let elapsed = state.flash_blue_elapsed.get();
    if elapsed <= 0.0 || elapsed >= FLASH_BLUE_DURATION {
        return;
    }
    let t = elapsed / FLASH_BLUE_DURATION;
    let alpha = (t * PI).sin().max(0.0);
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
    rounded_rect(cr, rx - 1.5, ry - 1.5, rw + 3.0, rh + 3.0, radius + 1.5);
    cr.set_source_rgba(gr, gg, gb, 0.35 * alpha);
    cr.set_line_width(FLASH_BLUE_BORDER_WIDTH + 2.0);
    let _ = cr.stroke();

    let (r, g, b) = FLASH_BLUE_COLOR;
    rounded_rect(cr, rx, ry, rw, rh, radius);
    cr.set_source_rgba(r, g, b, alpha);
    cr.set_line_width(FLASH_BLUE_BORDER_WIDTH);
    let _ = cr.stroke();
}

// ── Broadcast transcript ─────────────────────────────────────────

fn draw_broadcast_transcript(cr: &cairo::Context, state: &PillState, ww: f64, wh: f64) {
    let alpha = state.transcript_opacity.get();
    if alpha < 0.01 {
        return;
    }
    let text = state.transcript_text.borrow();
    if text.is_empty() {
        return;
    }

    cr.select_font_face("sans-serif", cairo::FontSlant::Normal, cairo::FontWeight::Normal);
    cr.set_font_size(TRANSCRIPT_FONT_SIZE);
    let extents = match cr.text_extents(&text) {
        Ok(e) => e,
        Err(_) => return,
    };
    let text_w = extents.width();
    let box_w = (text_w + TRANSCRIPT_PADDING_H * 2.0).min(TRANSCRIPT_MAX_WIDTH);

    let (_, pill_y, _, _) = pill_position(state, ww, wh);
    let box_x = (ww - box_w) / 2.0;
    let rise = (1.0 - alpha) * 6.0;
    let box_y = pill_y - TRANSCRIPT_GAP - TRANSCRIPT_HEIGHT + rise;

    rounded_rect(cr, box_x, box_y, box_w, TRANSCRIPT_HEIGHT, TRANSCRIPT_RADIUS);
    cr.set_source_rgba(0.0, 0.0, 0.0, alpha);
    let _ = cr.fill();

    rounded_rect(
        cr,
        box_x + 0.5,
        box_y + 0.5,
        box_w - 1.0,
        TRANSCRIPT_HEIGHT - 1.0,
        TRANSCRIPT_RADIUS - 0.5,
    );
    cr.set_source_rgba(0.45, 0.75, 1.0, 0.35 * alpha);
    cr.set_line_width(1.0);
    let _ = cr.stroke();

    let tx = box_x + (box_w - text_w) / 2.0 - extents.x_bearing();
    let ty = box_y + (TRANSCRIPT_HEIGHT - extents.height()) / 2.0 - extents.y_bearing();
    cr.move_to(tx, ty);
    cr.set_source_rgba(1.0, 1.0, 1.0, 0.95 * alpha);
    let _ = cr.show_text(&text);
}
