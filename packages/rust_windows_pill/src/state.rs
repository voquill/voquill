use std::cell::{Cell, RefCell};

use crate::ipc::{Phase, PillMessage, PillPermission, PillStreaming, Visibility};
use crate::constants::*;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum RocketPhase {
    Rising,
    Exploding,
}

#[derive(Debug, Clone)]
pub(crate) struct Spark {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) vx: f64,
    pub(crate) vy: f64,
    pub(crate) life: f64,
}

#[derive(Debug, Clone)]
pub(crate) struct Rocket {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) vx: f64,
    pub(crate) vy: f64,
    pub(crate) trail: Vec<(f64, f64)>,
    pub(crate) fuse: f64,
    pub(crate) phase: RocketPhase,
    pub(crate) num_sparks: usize,
    pub(crate) launch_index: usize,
    pub(crate) sparks: Vec<Spark>,
    pub(crate) trail_alpha: f64,
    pub(crate) color: (f64, f64, f64),
}

#[derive(Debug, Clone)]
pub(crate) enum ClickAction {
    Pill,
    StyleForward,
    StyleBackward,
    AssistantClose,
    OpenInNew,
    KeyboardButton,
    CancelDictation,
    PermissionAllow(String),
    PermissionDeny(String),
    PermissionAlwaysAllow(String),
    SendButton,
    InputField,
    FlashAction,
}

#[derive(Debug, Clone)]
pub(crate) struct ClickRegion {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) w: f64,
    pub(crate) h: f64,
    pub(crate) action: ClickAction,
}

impl ClickRegion {
    pub(crate) fn contains(&self, px: f64, py: f64) -> bool {
        px >= self.x && px <= self.x + self.w && py >= self.y && py <= self.y + self.h
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowMode {
    Dictation,
    AssistantCompact,
    AssistantExpanded,
    AssistantTyping,
}

impl WindowMode {
    pub(crate) fn from_str(s: &str) -> Self {
        match s {
            "assistant_compact" => Self::AssistantCompact,
            "assistant_expanded" => Self::AssistantExpanded,
            "assistant_typing" => Self::AssistantTyping,
            _ => Self::Dictation,
        }
    }

    pub(crate) fn dimensions(&self) -> (i32, i32) {
        match self {
            Self::Dictation => (DICTATION_WINDOW_WIDTH, DICTATION_WINDOW_HEIGHT),
            Self::AssistantCompact => (WINDOW_W_COMPACT, WINDOW_H_COMPACT),
            Self::AssistantExpanded => (WINDOW_W_EXPANDED, WINDOW_H_EXPANDED),
            Self::AssistantTyping => (WINDOW_W_TYPING, WINDOW_H_TYPING),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct FlameTongue {
    pub(crate) t: f64,
    pub(crate) height: f64,
    pub(crate) width: f64,
    pub(crate) phase: f64,
    pub(crate) speed: f64,
}

pub(crate) struct PillState {
    pub(crate) ui_scale: Cell<f64>,
    pub(crate) phase: Cell<Phase>,
    pub(crate) visibility: Cell<Visibility>,
    pub(crate) expand_t: Cell<f64>,
    pub(crate) expand_velocity: Cell<f64>,
    pub(crate) hovered: Cell<bool>,
    pub(crate) wave_phase: Cell<f64>,
    pub(crate) current_level: Cell<f64>,
    pub(crate) target_level: Cell<f64>,
    pub(crate) loading_offset: Cell<f64>,
    pub(crate) pending_levels: RefCell<Vec<f32>>,
    pub(crate) style_count: Cell<u32>,
    pub(crate) style_name: RefCell<String>,
    pub(crate) tooltip_t: Cell<f64>,
    pub(crate) tooltip_velocity: Cell<f64>,
    pub(crate) tooltip_width: Cell<f64>,

    pub(crate) window_mode: Cell<WindowMode>,
    pub(crate) draw_width: Cell<f64>,
    pub(crate) draw_height: Cell<f64>,
    pub(crate) draw_w_velocity: Cell<f64>,
    pub(crate) draw_h_velocity: Cell<f64>,

    pub(crate) assistant_active: Cell<bool>,
    pub(crate) assistant_input_mode: RefCell<String>,
    pub(crate) assistant_compact: Cell<bool>,
    pub(crate) assistant_conversation_id: RefCell<Option<String>>,
    pub(crate) assistant_user_prompt: RefCell<Option<String>>,
    pub(crate) assistant_messages: RefCell<Vec<PillMessage>>,
    pub(crate) assistant_streaming: RefCell<Option<PillStreaming>>,
    pub(crate) assistant_permissions: RefCell<Vec<PillPermission>>,

    pub(crate) panel_open_t: Cell<f64>,
    pub(crate) panel_open_velocity: Cell<f64>,
    pub(crate) kb_button_t: Cell<f64>,
    pub(crate) kb_button_velocity: Cell<f64>,
    pub(crate) shimmer_phase: Cell<f64>,

    pub(crate) scroll_offset: Cell<f64>,
    pub(crate) content_height: Cell<f64>,
    pub(crate) viewport_height: Cell<f64>,
    pub(crate) should_stick: Cell<bool>,

    pub(crate) click_regions: RefCell<Vec<ClickRegion>>,
    pub(crate) mouse_x: Cell<f64>,
    pub(crate) mouse_y: Cell<f64>,

    pub(crate) entry_text: RefCell<String>,

    // Cancel button animation
    pub(crate) cancel_t: Cell<f64>,
    pub(crate) cancel_velocity: Cell<f64>,

    // Flash message / toast
    pub(crate) flash_message: RefCell<String>,
    pub(crate) flash_visible: Cell<bool>,
    pub(crate) flash_t: Cell<f64>,
    pub(crate) flash_velocity: Cell<f64>,
    pub(crate) flash_timer: Cell<f64>,
    pub(crate) flash_is_error: Cell<bool>,
    pub(crate) flash_action: RefCell<Option<String>>,
    pub(crate) flash_action_label: RefCell<Option<String>>,

    pub(crate) fireworks_active: Cell<bool>,
    pub(crate) fireworks_elapsed: Cell<f64>,
    pub(crate) fireworks_next_launch: Cell<usize>,
    pub(crate) fireworks_rockets: RefCell<Vec<Rocket>>,

    // Flame
    pub(crate) flame_active: Cell<bool>,
    pub(crate) flame_elapsed: Cell<f64>,
    pub(crate) flame_tongues: RefCell<Vec<FlameTongue>>,

    // Flash blue border
    pub(crate) flash_blue_active: Cell<bool>,
    pub(crate) flash_blue_elapsed: Cell<f64>,

    // Broadcast transcript (live text above the pill)
    pub(crate) transcript_text: RefCell<String>,
    pub(crate) transcript_time_since_update: Cell<f64>,
    pub(crate) transcript_opacity: Cell<f64>,
    pub(crate) transcript_has_message: Cell<bool>,

    // Dirty flag — when false, the rendered output is identical to the previous
    // frame so we can skip draw + UpdateLayeredWindow entirely.
    pub(crate) dirty: Cell<bool>,
}

impl PillState {
    pub(crate) fn content_offset(&self) -> (f64, f64) {
        let dw = self.draw_width.get();
        let dh = self.draw_height.get();
        ((WINDOW_W_TYPING as f64 - dw) / 2.0, WINDOW_H_TYPING as f64 - dh)
    }

    pub(crate) fn needs_redraw(&self) -> bool {
        if self.dirty.get() { return true; }

        // Continuous animations driven by phase
        if self.phase.get() != Phase::Idle { return true; }

        // Spring animations still in motion
        if self.expand_velocity.get() != 0.0 { return true; }
        if self.tooltip_velocity.get() != 0.0 { return true; }
        if self.panel_open_velocity.get() != 0.0 { return true; }
        if self.kb_button_velocity.get() != 0.0 { return true; }
        if self.draw_w_velocity.get() != 0.0 { return true; }
        if self.draw_h_velocity.get() != 0.0 { return true; }
        if self.flash_velocity.get() != 0.0 { return true; }
        if self.cancel_velocity.get() != 0.0 { return true; }

        // Active visual effects
        if self.fireworks_active.get() { return true; }
        if self.flame_active.get() { return true; }
        if self.flash_visible.get() { return true; }
        if self.flash_blue_active.get() { return true; }
        if self.transcript_has_message.get() { return true; }
        if self.transcript_opacity.get() > 0.001 { return true; }

        // Assistant panel has shimmer and streaming content
        if self.assistant_active.get() { return true; }

        false
    }
}
