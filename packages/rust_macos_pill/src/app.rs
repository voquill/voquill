use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;

use cocoa::appkit::{
    NSApp, NSApplication, NSApplicationActivationPolicyAccessory, NSBackingStoreBuffered,
    NSWindow, NSWindowCollectionBehavior,
};
use cocoa::base::{id, nil, NO, YES};
use cocoa::foundation::{NSAutoreleasePool, NSPoint, NSRect, NSSize, NSString};
use objc::declare::ClassDecl;
use objc::runtime::{Class, Object, Sel, BOOL};

use crate::constants::*;
use crate::draw;
use crate::gfx::{self, Ctx};
use crate::input;
use crate::ipc::{self, InMessage, OutMessage, Phase, Visibility};
use crate::state::{FlameTongue, PillState, Rocket, RocketPhase, Spark, WindowMode};

// ── CVDisplayLink & timing ───────────────────────────────────────

#[link(name = "CoreVideo", kind = "framework")]
extern "C" {
    fn CVDisplayLinkCreateWithActiveCGDisplays(link_out: *mut *mut c_void) -> i32;
    fn CVDisplayLinkSetOutputCallback(
        link: *mut c_void,
        callback: extern "C" fn(*mut c_void, *const c_void, *const c_void, u64, *mut u64, *mut c_void) -> i32,
        context: *mut c_void,
    ) -> i32;
    fn CVDisplayLinkStart(link: *mut c_void) -> i32;
}

extern "C" {
    fn dispatch_async_f(queue: *mut c_void, context: *mut c_void, work: extern "C" fn(*mut c_void));
    static _dispatch_main_q: u8;
    fn CFAbsoluteTimeGetCurrent() -> f64;
}

// ── Thread-local shared state ─────────────────────────────────────

struct AppContext {
    state: Rc<PillState>,
    receiver: RefCell<Receiver<InMessage>>,
    window: id,
    view: id,
    entry: id,
    quit: Cell<bool>,
    last_tick_time: Cell<f64>,
    embedded: bool,
}

thread_local! {
    static APP_CTX: RefCell<Option<AppContext>> = const { RefCell::new(None) };
}

fn with_ctx<R>(f: impl FnOnce(&AppContext) -> R) -> Option<R> {
    APP_CTX.with(|cell| cell.borrow().as_ref().map(f))
}

// ── CVDisplayLink vsync callback ─────────────────────────────────

static NEEDS_TICK: AtomicBool = AtomicBool::new(false);

extern "C" fn display_link_callback(
    _link: *mut c_void, _now: *const c_void, _output_time: *const c_void,
    _flags_in: u64, _flags_out: *mut u64, _context: *mut c_void,
) -> i32 {
    if !NEEDS_TICK.swap(true, Ordering::Release) {
        unsafe {
            let main_q = &_dispatch_main_q as *const u8 as *mut c_void;
            dispatch_async_f(main_q, std::ptr::null_mut(), main_thread_tick);
        }
    }
    0
}

extern "C" fn main_thread_tick(_context: *mut c_void) {
    NEEDS_TICK.store(false, Ordering::Release);
    perform_tick();
}

// ── Custom NSView ─────────────────────────────────────────────────

fn register_pill_view_class() -> &'static Class {
    let superclass = Class::get("NSView").unwrap();
    let mut decl = ClassDecl::new("VoquillPillView", superclass).unwrap();

    unsafe {
        decl.add_method(sel!(drawRect:), draw_rect as extern "C" fn(&Object, Sel, NSRect));
        decl.add_method(sel!(isFlipped), is_flipped as extern "C" fn(&Object, Sel) -> BOOL);
        decl.add_method(sel!(acceptsFirstResponder), accepts_first_responder as extern "C" fn(&Object, Sel) -> BOOL);
        decl.add_method(sel!(acceptsFirstMouse:), accepts_first_mouse as extern "C" fn(&Object, Sel, id) -> BOOL);
        decl.add_method(sel!(mouseDown:), mouse_down as extern "C" fn(&Object, Sel, id));
        decl.add_method(sel!(mouseEntered:), mouse_entered as extern "C" fn(&Object, Sel, id));
        decl.add_method(sel!(mouseExited:), mouse_exited as extern "C" fn(&Object, Sel, id));
        decl.add_method(sel!(mouseUp:), mouse_up as extern "C" fn(&Object, Sel, id));
        decl.add_method(sel!(scrollWheel:), scroll_wheel as extern "C" fn(&Object, Sel, id));
        decl.add_method(sel!(updateTrackingAreas), update_tracking_areas as extern "C" fn(&Object, Sel));
        decl.add_method(sel!(tick:), tick_callback as extern "C" fn(&Object, Sel, id));
        decl.add_method(sel!(hitTest:), hit_test as extern "C" fn(&Object, Sel, NSPoint) -> id);
        decl.add_method(sel!(textFieldAction:), text_field_action as extern "C" fn(&Object, Sel, id));
    }

    decl.register()
}

fn register_pill_window_class() -> &'static Class {
    let superclass = Class::get("NSPanel").unwrap();
    let mut decl = ClassDecl::new("VoquillPillWindow", superclass).unwrap();

    unsafe {
        decl.add_method(sel!(canBecomeKeyWindow), can_become_key_window as extern "C" fn(&Object, Sel) -> BOOL);
    }

    decl.register()
}

// ── ObjC method implementations ──────────────────────────────────

extern "C" fn is_flipped(_this: &Object, _sel: Sel) -> BOOL {
    YES
}

extern "C" fn accepts_first_responder(_this: &Object, _sel: Sel) -> BOOL {
    YES
}

extern "C" fn can_become_key_window(_this: &Object, _sel: Sel) -> BOOL {
    let is_typing = with_ctx(|ctx| {
        ctx.state.assistant_active.get()
            && *ctx.state.assistant_input_mode.borrow() == "type"
    });
    if is_typing.unwrap_or(false) { YES } else { NO }
}

extern "C" fn accepts_first_mouse(_this: &Object, _sel: Sel, _event: id) -> BOOL {
    YES
}

extern "C" fn mouse_down(_this: &Object, _sel: Sel, _event: id) {
    // Don't call super — prevents the window from stealing focus on click
}

extern "C" fn draw_rect(this: &Object, _sel: Sel, _dirty: NSRect) {
    with_ctx(|ctx| {
        unsafe {
            let ns_ctx: id = msg_send![class!(NSGraphicsContext), currentContext];
            let cg_ctx: gfx::CGContextRef = msg_send![ns_ctx, CGContext];
            let bounds: NSRect = msg_send![this, bounds];
            let gfx_ctx = Ctx::new(cg_ctx);
            draw::draw_all(&gfx_ctx, &ctx.state, bounds.size.width, bounds.size.height);
        }
    });
}

extern "C" fn mouse_entered(_this: &Object, _sel: Sel, _event: id) {}

extern "C" fn mouse_exited(_this: &Object, _sel: Sel, _event: id) {
    with_ctx(|ctx| {
        if ctx.state.hovered.get() {
            ctx.state.hovered.set(false);
            ipc::send(&OutMessage::Hover { hovered: false });
        }
    });
}

extern "C" fn mouse_up(_this: &Object, _sel: Sel, event: id) {
    with_ctx(|ctx| {
        unsafe {
            let loc: NSPoint = msg_send![event, locationInWindow];
            let view_loc: NSPoint = msg_send![_this, convertPoint:loc fromView:nil];
            input::handle_click(&ctx.state, view_loc.x, view_loc.y);
        }
    });
}

extern "C" fn scroll_wheel(_this: &Object, _sel: Sel, event: id) {
    with_ctx(|ctx| {
        unsafe {
            let precise: bool = msg_send![event, hasPreciseScrollingDeltas];
            let dy: f64 = if precise {
                msg_send![event, scrollingDeltaY]
            } else {
                let line_dy: f64 = msg_send![event, deltaY];
                line_dy * 30.0
            };
            input::handle_scroll(&ctx.state, dy);
        }
    });
}

extern "C" fn update_tracking_areas(this: &Object, _sel: Sel) {
    unsafe {
        // Remove existing tracking areas
        let areas: id = msg_send![this, trackingAreas];
        let count: usize = msg_send![areas, count];
        for i in (0..count).rev() {
            let area: id = msg_send![areas, objectAtIndex:i];
            let _: () = msg_send![this, removeTrackingArea:area];
        }

        // Add new tracking area for the full bounds
        let bounds: NSRect = msg_send![this, bounds];
        let options: usize = 0x01 | 0x02 | 0x10 | 0x20;
        // NSTrackingMouseEnteredAndExited | NSTrackingMouseMoved | NSTrackingActiveAlways | NSTrackingInVisibleRect
        let area: id = msg_send![class!(NSTrackingArea), alloc];
        let area: id = msg_send![area, initWithRect:bounds options:options owner:this userInfo:nil];
        let _: () = msg_send![this, addTrackingArea:area];

        // Call super
        let superclass = Class::get("NSView").unwrap();
        let _: () = msg_send![super(this, superclass), updateTrackingAreas];
    }
}

extern "C" fn hit_test(this: &Object, _sel: Sel, point: NSPoint) -> id {
    let interactive = with_ctx(|ctx| {
        unsafe {
            let local: NSPoint = msg_send![this, convertPoint:point fromView:nil];
            input::is_interactive_at(&ctx.state, local.x, local.y)
        }
    });

    if interactive.unwrap_or(false) {
        unsafe {
            let superclass = Class::get("NSView").unwrap();
            msg_send![super(this, superclass), hitTest:point]
        }
    } else {
        nil
    }
}

extern "C" fn text_field_action(_this: &Object, _sel: Sel, sender: id) {
    with_ctx(|ctx| {
        unsafe {
            let ns_text: id = msg_send![sender, stringValue];
            let cstr: *const std::os::raw::c_char = msg_send![ns_text, UTF8String];
            let text = std::ffi::CStr::from_ptr(cstr).to_str().unwrap_or("").trim().to_string();
            if !text.is_empty() {
                ipc::send(&OutMessage::TypedMessage { text });
                let empty: id = NSString::alloc(nil).init_str("");
                let _: () = msg_send![sender, setStringValue:empty];
                *ctx.state.entry_text.borrow_mut() = String::new();
            }
        }
    });
}

extern "C" fn tick_callback(_this: &Object, _sel: Sel, _timer: id) {
    perform_tick();
}

fn perform_tick() {
    APP_CTX.with(|cell| {
        let borrow = cell.borrow();
        let Some(ctx) = borrow.as_ref() else { return };

        // Delta time (frame-rate independent animation)
        let now = unsafe { CFAbsoluteTimeGetCurrent() };
        let prev = ctx.last_tick_time.get();
        ctx.last_tick_time.set(now);
        let dt = if prev == 0.0 { 1.0 / 60.0 } else { (now - prev).clamp(0.001, 0.05) };

        // Process IPC messages
        let rx = ctx.receiver.borrow();
        while let Ok(msg) = rx.try_recv() {
            match msg {
                InMessage::Phase { phase } => {
                    let prev = ctx.state.phase.get();
                    ctx.state.phase.set(phase);
                    if phase == Phase::Idle && prev != Phase::Idle {
                        ctx.state.target_level.set(0.0);
                        ctx.state.current_level.set(0.0);
                        ctx.state.wave_phase.set(0.0);
                    }
                }
                InMessage::Levels { levels } => {
                    *ctx.state.pending_levels.borrow_mut() = levels;
                }
                InMessage::StyleInfo { count, name } => {
                    ctx.state.style_count.set(count);
                    *ctx.state.style_name.borrow_mut() = name;
                }
                InMessage::Toast { message, toast_type, duration, action, action_label } => {
                    *ctx.state.flash_message.borrow_mut() = message;
                    ctx.state.flash_is_error.set(toast_type.as_deref() == Some("error"));
                    ctx.state.flash_visible.set(true);
                    ctx.state.flash_timer.set(duration.unwrap_or(FLASH_DURATION));
                    *ctx.state.flash_action.borrow_mut() = action;
                    *ctx.state.flash_action_label.borrow_mut() = action_label;
                }
                InMessage::DismissToast => {
                    ctx.state.flash_visible.set(false);
                    ctx.state.flash_timer.set(0.0);
                    *ctx.state.flash_action.borrow_mut() = None;
                    *ctx.state.flash_action_label.borrow_mut() = None;
                }
                InMessage::Fireworks { message } => {
                    *ctx.state.flash_message.borrow_mut() = message;
                    ctx.state.flash_is_error.set(false);
                    *ctx.state.flash_action.borrow_mut() = None;
                    *ctx.state.flash_action_label.borrow_mut() = None;
                    ctx.state.flash_visible.set(true);
                    ctx.state.flash_timer.set(FIREWORKS_TOTAL_DURATION);

                    ctx.state.fireworks_active.set(true);
                    ctx.state.fireworks_elapsed.set(0.0);
                    ctx.state.fireworks_next_launch.set(0);
                    ctx.state.fireworks_rockets.borrow_mut().clear();
                }
                InMessage::Flame { message } => {
                    *ctx.state.flash_message.borrow_mut() = message;
                    ctx.state.flash_is_error.set(false);
                    *ctx.state.flash_action.borrow_mut() = None;
                    *ctx.state.flash_action_label.borrow_mut() = None;
                    ctx.state.flash_visible.set(true);
                    ctx.state.flash_timer.set(FLAME_TOTAL_DURATION);

                    ctx.state.flame_active.set(true);
                    ctx.state.flame_elapsed.set(0.0);
                    ctx.state.flame_tongues.borrow_mut().clear();
                }
                InMessage::FlashBlue => {
                    ctx.state.flash_blue_active.set(true);
                    ctx.state.flash_blue_elapsed.set(0.0);
                }
                InMessage::BroadcastTranscript { text } => {
                    *ctx.state.transcript_text.borrow_mut() = text;
                    ctx.state.transcript_time_since_update.set(0.0);
                    ctx.state.transcript_has_message.set(true);
                }
                InMessage::Visibility { visibility } => {
                    ctx.state.visibility.set(visibility);
                }
                InMessage::WindowSize { ref size } => {
                    let mode = WindowMode::from_str(size);
                    ctx.state.window_mode.set(mode);
                }
                InMessage::AssistantState {
                    active,
                    input_mode,
                    compact,
                    conversation_id,
                    user_prompt,
                    messages,
                    streaming,
                    permissions,
                } => {
                    let was_active = ctx.state.assistant_active.get();
                    ctx.state.assistant_active.set(active);
                    *ctx.state.assistant_input_mode.borrow_mut() = input_mode;
                    ctx.state.assistant_compact.set(compact);
                    *ctx.state.assistant_conversation_id.borrow_mut() = conversation_id;
                    *ctx.state.assistant_user_prompt.borrow_mut() = user_prompt;
                    *ctx.state.assistant_messages.borrow_mut() = messages;
                    *ctx.state.assistant_streaming.borrow_mut() = streaming;
                    *ctx.state.assistant_permissions.borrow_mut() = permissions;

                    if active && !was_active {
                        ctx.state.should_stick.set(true);
                        ctx.state.scroll_offset.set(0.0);
                    }
                }
                InMessage::Quit => {
                    ctx.quit.set(true);
                }
            }
        }
        drop(rx);

        if ctx.quit.get() {
            unsafe {
                if ctx.embedded {
                    let _: () = msg_send![ctx.window, orderOut:nil];
                } else {
                    let app: id = msg_send![class!(NSApplication), sharedApplication];
                    let _: () = msg_send![app, terminate:nil];
                }
            }
            return;
        }

        // Compute hover from actual mouse position over pill area
        update_hover(ctx.view, ctx);

        tick(&ctx.state, dt);

        // Show/hide entry for typing mode
        let is_typing = ctx.state.assistant_active.get()
            && *ctx.state.assistant_input_mode.borrow() == "type";
        unsafe {
            let entry = ctx.entry;
            let entry_hidden: BOOL = msg_send![entry, isHidden];
            if is_typing && entry_hidden != NO {
                let _: () = msg_send![entry, setHidden:NO];
                // Don't call makeKeyWindow — it can activate the app and steal focus
                // from the user's target application. makeFirstResponder is sufficient
                // for keyboard input in a non-activating panel.
                let _: () = msg_send![ctx.window, makeFirstResponder:entry];
            } else if !is_typing && entry_hidden == NO {
                let _: () = msg_send![entry, setHidden:YES];
                let _: () = msg_send![ctx.window, resignKeyWindow];
            }

            // Sync entry text to state
            if is_typing {
                let ns_text: id = msg_send![entry, stringValue];
                let cstr: *const std::os::raw::c_char = msg_send![ns_text, UTF8String];
                let text = std::ffi::CStr::from_ptr(cstr).to_str().unwrap_or("").to_string();
                *ctx.state.entry_text.borrow_mut() = text;
            }
        }

        // Visibility
        let visibility = ctx.state.visibility.get();
        let is_active = ctx.state.phase.get() != Phase::Idle;
        let is_assistant = ctx.state.assistant_active.get();
        let should_show = match visibility {
            Visibility::Hidden => is_assistant,
            Visibility::WhileActive => is_active || is_assistant,
            Visibility::Persistent => true,
        };
        unsafe {
            if should_show {
                let _: () = msg_send![ctx.window, orderFront:nil];
            } else {
                let _: () = msg_send![ctx.window, orderOut:nil];
            }
        }

        // Reposition window on active monitor
        reposition_window(ctx.window);

        // Request redraw
        unsafe {
            let _: () = msg_send![ctx.view, setNeedsDisplay:YES];
        }
    });
}

// ── Hover detection ──────────────────────────────────────────────

fn update_hover(view: id, ctx: &AppContext) {
    let new_hovered = unsafe {
        let window: id = msg_send![view, window];
        let mouse_screen: NSPoint = msg_send![class!(NSEvent), mouseLocation];
        let mouse_win: NSPoint = msg_send![window, convertPointFromScreen:mouse_screen];
        let mouse_view: NSPoint = msg_send![view, convertPoint:mouse_win fromView:nil];
        input::is_in_hover_zone(&ctx.state, mouse_view.x, mouse_view.y)
    };

    let was_hovered = ctx.state.hovered.get();
    if new_hovered != was_hovered {
        ctx.state.hovered.set(new_hovered);
        ipc::send(&OutMessage::Hover { hovered: new_hovered });
    }
}

// ── Animation tick ────────────────────────────────────────────────

fn tick(state: &PillState, dt: f64) {
    let phase = state.phase.get();
    let is_active = phase != Phase::Idle;
    let is_recording = phase == Phase::Recording;
    let is_loading = phase == Phase::Loading;
    let hovered = state.hovered.get();
    let frame_scale = dt * 60.0; // Scale factor relative to 60fps baseline

    // Audio levels (frame-rate independent)
    if is_recording {
        let levels = state.pending_levels.borrow();
        if !levels.is_empty() {
            let sum: f64 = levels.iter().map(|v| *v as f64).sum();
            let avg = sum / levels.len() as f64;
            let peak = levels.iter().copied().fold(0.0_f32, f32::max) as f64;
            let combined = (avg * 0.9 + peak * 0.85).min(1.0);
            let boosted = (combined.sqrt() * 1.35).min(1.0);
            let target = state.target_level.get();
            let mix = 1.0 - 0.25_f64.powf(frame_scale);
            state.target_level.set((target * (1.0 - mix) + boosted * mix).min(1.0));
        }
    } else if is_loading {
        let target = state.target_level.get();
        state.target_level.set(target.max(PROCESSING_BASE_LEVEL));
    } else {
        state.target_level.set(0.0);
        state.current_level.set(state.current_level.get() * 0.4_f64.powf(frame_scale));
        if state.current_level.get() < 0.0002 {
            state.current_level.set(0.0);
        }
    }

    let current = state.current_level.get();
    let target = state.target_level.get();
    let smoothing = 1.0 - (1.0 - LEVEL_SMOOTHING).powf(frame_scale);
    let new_current = current + (target - current) * smoothing;
    state.current_level.set(if new_current < 0.0002 { 0.0 } else { new_current });

    let decay = TARGET_DECAY_PER_FRAME.powf(frame_scale);
    let decayed = target * decay;
    state.target_level.set(if decayed < 0.0005 { 0.0 } else { decayed });

    let level = state.current_level.get();
    let base_level = if is_loading && !is_recording { PROCESSING_BASE_LEVEL } else { 0.0 };
    let effective_level = level.max(base_level);
    let advance = (WAVE_BASE_PHASE_STEP + WAVE_PHASE_GAIN * effective_level) * frame_scale;
    state.wave_phase.set((state.wave_phase.get() + advance) % TAU);

    // Pill expand/collapse (spring)
    let expand_target = if is_active || hovered || state.assistant_active.get() { 1.0 } else { 0.0 };
    spring_anim(&state.expand_t, &state.expand_velocity, expand_target, SPRING_STIFFNESS, dt);

    // Loading offset
    if is_loading {
        state.loading_offset.set((state.loading_offset.get() + LOADING_SPEED * frame_scale) % 1.0);
    }

    // Tooltip animation (spring)
    let show_tooltip = !state.assistant_active.get()
        && state.style_count.get() > 1
        && (hovered || phase == Phase::Recording)
        && state.expand_t.get() > 0.3;
    let tooltip_target = if show_tooltip { 1.0 } else { 0.0 };
    spring_anim(&state.tooltip_t, &state.tooltip_velocity, tooltip_target, SPRING_STIFFNESS, dt);

    // Panel open/close (spring)
    let panel_target = if state.assistant_active.get() { 1.0 } else { 0.0 };
    spring_anim(&state.panel_open_t, &state.panel_open_velocity, panel_target, SPRING_STIFFNESS, dt);

    // Keyboard button (spring)
    let is_voice = *state.assistant_input_mode.borrow() == "voice";
    let kb_target = if state.assistant_active.get() && is_voice { 1.0 } else { 0.0 };
    spring_anim(&state.kb_button_t, &state.kb_button_velocity, kb_target, SPRING_STIFFNESS, dt);

    // Animate content dimensions toward target mode
    let mode = state.window_mode.get();
    let (tw, th) = mode.dimensions();
    spring_px(&state.draw_width, &state.draw_w_velocity, tw as f64, SPRING_STIFFNESS, dt);
    spring_px(&state.draw_height, &state.draw_h_velocity, th as f64, SPRING_STIFFNESS, dt);

    // Shimmer phase
    state.shimmer_phase.set((state.shimmer_phase.get() + SHIMMER_SPEED * frame_scale) % 1.0);

    // Fireworks
    tick_fireworks(state, dt);

    // Flame
    tick_flame(state, dt);

    // Flash blue border
    tick_flash_blue(state, dt);

    // Broadcast transcript
    tick_transcript(state, dt);

    // Flash message timer
    if state.flash_visible.get() {
        let remaining = state.flash_timer.get() - dt;
        if remaining <= 0.0 {
            state.flash_visible.set(false);
            state.flash_timer.set(0.0);
            *state.flash_action.borrow_mut() = None;
            *state.flash_action_label.borrow_mut() = None;
        } else {
            state.flash_timer.set(remaining);
        }
    }
    let flash_target = if state.flash_visible.get() { 1.0 } else { 0.0 };
    spring_anim(&state.flash_t, &state.flash_velocity, flash_target, SPRING_STIFFNESS, dt);

    // Cancel button
    let cancel_target = if state.hovered.get()
        && state.phase.get() != Phase::Idle
        && !state.assistant_active.get()
    { 1.0 } else { 0.0 };
    spring_anim(&state.cancel_t, &state.cancel_velocity, cancel_target, SPRING_STIFFNESS * 2.0, dt);

    // Auto-scroll to bottom
    if state.should_stick.get() && state.assistant_active.get() && !state.assistant_compact.get() {
        let max_scroll = (state.content_height.get() - state.viewport_height.get()).max(0.0);
        state.scroll_offset.set(max_scroll);
    }
}

fn tick_fireworks(state: &PillState, dt: f64) {
    if !state.fireworks_active.get() {
        return;
    }

    let elapsed = state.fireworks_elapsed.get() + dt;
    state.fireworks_elapsed.set(elapsed);

    let ww = state.draw_width.get();
    let wh = state.draw_height.get();
    let (_, pill_y, _, _) = draw::pill_position(state, ww, wh);
    let origin_x = ww / 2.0;
    let origin_y = pill_y - FLASH_GAP - FLASH_HEIGHT / 2.0;

    // Launch rockets on schedule
    let mut next = state.fireworks_next_launch.get();
    let mut rockets = state.fireworks_rockets.borrow_mut();

    while next < FIREWORK_LAUNCHES.len() && elapsed >= FIREWORK_LAUNCHES[next].time {
        let launch = &FIREWORK_LAUNCHES[next];
        let angle_rad = launch.angle_deg.to_radians();
        let color = FIREWORK_COLORS[next % FIREWORK_COLORS.len()];
        rockets.push(Rocket {
            x: origin_x,
            y: origin_y,
            vx: launch.speed * angle_rad.sin(),
            vy: -launch.speed * angle_rad.cos(),
            trail: vec![(origin_x, origin_y)],
            fuse: launch.fuse,
            phase: RocketPhase::Rising,
            num_sparks: launch.num_sparks,
            launch_index: next,
            sparks: Vec::new(),
            trail_alpha: 1.0,
            color,
        });
        next += 1;
    }
    state.fireworks_next_launch.set(next);

    for rocket in rockets.iter_mut() {
        match rocket.phase {
            RocketPhase::Rising => {
                rocket.vy += FIREWORKS_GRAVITY * dt;
                rocket.x += rocket.vx * dt;
                rocket.y += rocket.vy * dt;

                rocket.trail.push((rocket.x, rocket.y));
                if rocket.trail.len() > FIREWORKS_TRAIL_MAX {
                    rocket.trail.remove(0);
                }

                rocket.fuse -= dt;
                if rocket.fuse <= 0.0 {
                    rocket.phase = RocketPhase::Exploding;
                    let offset = rocket.launch_index as f64 * 0.7;
                    for i in 0..rocket.num_sparks {
                        let n = rocket.num_sparks.max(1) as f64;
                        let angle = TAU * i as f64 / n + offset;
                        let speed_t = ((i * 7 + 3) % rocket.num_sparks.max(1)) as f64 / n;
                        let speed = FIREWORKS_SPARK_BASE_SPEED * (0.6 + 0.8 * speed_t);
                        rocket.sparks.push(Spark {
                            x: rocket.x,
                            y: rocket.y,
                            vx: speed * angle.cos(),
                            vy: speed * angle.sin(),
                            life: 1.0,
                        });
                    }
                }
            }
            RocketPhase::Exploding => {
                for spark in rocket.sparks.iter_mut() {
                    let drag = (-FIREWORKS_SPARK_DRAG * dt).exp();
                    spark.vx *= drag;
                    spark.vy *= drag;
                    spark.vy += FIREWORKS_GRAVITY * 0.3 * dt;
                    spark.x += spark.vx * dt;
                    spark.y += spark.vy * dt;
                    spark.life -= dt / FIREWORKS_SPARK_LIFE;
                }

                rocket.trail_alpha -= FIREWORKS_TRAIL_FADE_RATE * dt;
                if rocket.trail_alpha < 0.0 {
                    rocket.trail_alpha = 0.0;
                }
            }
        }
    }

    rockets.retain(|r| match r.phase {
        RocketPhase::Rising => true,
        RocketPhase::Exploding => r.trail_alpha > 0.01 || r.sparks.iter().any(|s| s.life > 0.0),
    });

    if elapsed >= FIREWORKS_TOTAL_DURATION && rockets.is_empty() {
        state.fireworks_active.set(false);
    }
}

fn tick_flame(state: &PillState, dt: f64) {
    if !state.flame_active.get() {
        return;
    }
    let elapsed = state.flame_elapsed.get() + dt;
    state.flame_elapsed.set(elapsed);

    let mut tongues = state.flame_tongues.borrow_mut();

    if tongues.is_empty() {
        for i in 0..FLAME_TONGUE_COUNT {
            let t = if FLAME_TONGUE_COUNT > 1 {
                i as f64 / (FLAME_TONGUE_COUNT - 1) as f64
            } else {
                0.5
            };
            let hash = (i as u64).wrapping_mul(2654435761);
            let h_t = (hash % 1000) as f64 / 1000.0;
            let w_t = ((hash >> 10) % 1000) as f64 / 1000.0;
            let phase = ((hash >> 20) % 1000) as f64 / 1000.0 * TAU;
            let speed_var = ((hash >> 30) % 1000) as f64 / 1000.0;

            tongues.push(FlameTongue {
                t,
                height: FLAME_MIN_HEIGHT + (FLAME_MAX_HEIGHT - FLAME_MIN_HEIGHT) * h_t,
                width: FLAME_MIN_WIDTH + (FLAME_MAX_WIDTH - FLAME_MIN_WIDTH) * w_t,
                phase,
                speed: FLAME_SPEED_BASE * (0.8 + 0.4 * speed_var),
            });
        }
    }

    for tongue in tongues.iter_mut() {
        tongue.phase += tongue.speed * dt;
    }

    if elapsed >= FLAME_TOTAL_DURATION {
        state.flame_active.set(false);
        tongues.clear();
    }
}

fn tick_flash_blue(state: &PillState, dt: f64) {
    if !state.flash_blue_active.get() {
        return;
    }
    let elapsed = state.flash_blue_elapsed.get() + dt;
    if elapsed >= FLASH_BLUE_DURATION {
        state.flash_blue_active.set(false);
        state.flash_blue_elapsed.set(0.0);
    } else {
        state.flash_blue_elapsed.set(elapsed);
    }
}

fn tick_transcript(state: &PillState, dt: f64) {
    if !state.transcript_has_message.get() && state.transcript_opacity.get() < 0.001 {
        return;
    }
    let since = state.transcript_time_since_update.get() + dt;
    state.transcript_time_since_update.set(since);

    let target = if state.transcript_has_message.get() && since < TRANSCRIPT_FADE_DELAY {
        1.0
    } else {
        0.0
    };

    let speed = if target > 0.5 { TRANSCRIPT_RISE_SPEED } else { TRANSCRIPT_FADE_SPEED };
    let opacity = state.transcript_opacity.get();
    let blend = 1.0 - (-speed * dt).exp();
    let next = opacity + (target - opacity) * blend;
    state.transcript_opacity.set(next);

    if target == 0.0 && next < 0.002 {
        state.transcript_opacity.set(0.0);
        state.transcript_has_message.set(false);
        state.transcript_text.borrow_mut().clear();
    }
}

fn spring_anim(value: &Cell<f64>, velocity: &Cell<f64>, target: f64, stiffness: f64, dt: f64) {
    let v = value.get();
    let vel = velocity.get();
    if v == target && vel == 0.0 { return; }
    let damping = 2.0 * stiffness.sqrt();
    let force = stiffness * (target - v) - damping * vel;
    let new_vel = vel + force * dt;
    let new_v = v + new_vel * dt;
    if (new_v - target).abs() < 0.002 && new_vel.abs() < 0.5 {
        value.set(target);
        velocity.set(0.0);
    } else {
        value.set(new_v.clamp(0.0, 1.0));
        velocity.set(if !(0.0..=1.0).contains(&new_v) { 0.0 } else { new_vel });
    }
}

fn spring_px(value: &Cell<f64>, velocity: &Cell<f64>, target: f64, stiffness: f64, dt: f64) {
    let v = value.get();
    let vel = velocity.get();
    if v == target && vel == 0.0 { return; }
    let damping = 2.0 * stiffness.sqrt();
    let force = stiffness * (target - v) - damping * vel;
    let new_vel = vel + force * dt;
    let new_v = v + new_vel * dt;
    if (new_v - target).abs() < 0.5 && (new_vel * dt).abs() < 0.5 {
        value.set(target);
        velocity.set(0.0);
    } else {
        value.set(new_v);
        velocity.set(new_vel);
    }
}

// ── Window positioning ────────────────────────────────────────────

fn reposition_window(window: id) {
    unsafe {
        let mouse_loc: NSPoint = msg_send![class!(NSEvent), mouseLocation];
        let screens: id = msg_send![class!(NSScreen), screens];
        let count: usize = msg_send![screens, count];

        for i in 0..count {
            let screen: id = msg_send![screens, objectAtIndex:i];
            let frame: NSRect = msg_send![screen, frame];

            if mouse_loc.x >= frame.origin.x
                && mouse_loc.x < frame.origin.x + frame.size.width
                && mouse_loc.y >= frame.origin.y
                && mouse_loc.y < frame.origin.y + frame.size.height
            {
                let visible: NSRect = msg_send![screen, visibleFrame];
                let win_frame: NSRect = msg_send![window, frame];
                let x = visible.origin.x + (visible.size.width - win_frame.size.width) / 2.0;
                let y = visible.origin.y + MARGIN_BOTTOM as f64;

                let current_origin: NSPoint = {
                    let f: NSRect = msg_send![window, frame];
                    f.origin
                };
                if (current_origin.x - x).abs() > 1.0 || (current_origin.y - y).abs() > 1.0 {
                    let origin = NSPoint::new(x, y);
                    let _: () = msg_send![window, setFrameOrigin:origin];
                }
                break;
            }
        }
    }
}

// ── Shared setup (used by both standalone and embedded modes) ─────

unsafe fn setup(receiver: Receiver<InMessage>, embedded: bool) {
    let view_class = register_pill_view_class();
    let window_class = register_pill_window_class();

    let ui_scale = 1.0; // macOS handles Retina scaling automatically

    let window_w = WINDOW_W_TYPING as f64;
    let window_h = WINDOW_H_TYPING as f64;

    // Create window (NSPanel with non-activating mask so clicks don't steal focus)
    let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(window_w, window_h));
    let non_activating_mask: u64 = 1 << 7; // NSWindowStyleMaskNonactivatingPanel
    let window: id = msg_send![window_class, alloc];
    let window: id = msg_send![window,
        initWithContentRect:rect
        styleMask:non_activating_mask
        backing:NSBackingStoreBuffered
        defer:NO
    ];

    let _: () = msg_send![window, setBecomesKeyOnlyIfNeeded:YES];
    window.setLevel_(1000); // NSScreenSaverWindowLevel
    window.setOpaque_(NO);
    let clear_color: id = msg_send![class!(NSColor), clearColor];
    window.setBackgroundColor_(clear_color);
    window.setHasShadow_(NO);
    window.setCollectionBehavior_(
        NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorIgnoresCycle,
    );

    // Create custom view (layer-backed for GPU-accelerated compositing)
    let view: id = msg_send![view_class, alloc];
    let view: id = msg_send![view, initWithFrame:rect];
    let _: () = msg_send![view, setWantsLayer:YES];
    window.setContentView_(view);

    // Create text field for typing mode
    let panel_w = PANEL_EXPANDED_WIDTH;
    let panel_x = (window_w - panel_w) / 2.0;
    let entry_x = panel_x + PANEL_CONTENT_SIDE_INSET;
    let entry_w = panel_w - PANEL_CONTENT_SIDE_INSET * 2.0 - 36.0;
    let entry_top_pad = 12.0;
    let entry_y = window_h - PANEL_BOTTOM_MARGIN - PANEL_INPUT_HEIGHT + entry_top_pad;
    let entry_h = PANEL_INPUT_HEIGHT - entry_top_pad;
    let entry_frame = NSRect::new(
        NSPoint::new(entry_x, entry_y),
        NSSize::new(entry_w, entry_h),
    );
    let entry: id = msg_send![class!(NSTextField), alloc];
    let entry: id = msg_send![entry, initWithFrame:entry_frame];
    let _: () = msg_send![entry, setBordered:NO];
    let _: () = msg_send![entry, setDrawsBackground:NO];
    let _: () = msg_send![entry, setFocusRingType:1u64]; // NSFocusRingTypeNone

    let white: id = msg_send![class!(NSColor),
        colorWithSRGBRed:1.0_f64
        green:1.0_f64
        blue:1.0_f64
        alpha:0.92_f64
    ];
    let _: () = msg_send![entry, setTextColor:white];

    let font: id = msg_send![class!(NSFont), systemFontOfSize:14.0_f64];
    let _: () = msg_send![entry, setFont:font];

    let placeholder = NSString::alloc(nil).init_str("Type a message...");
    let _: () = msg_send![entry, setPlaceholderString:placeholder];

    let _: () = msg_send![entry, setTarget:view];
    let _: () = msg_send![entry, setAction:sel!(textFieldAction:)];
    let _: () = msg_send![entry, setHidden:YES];
    let _: () = msg_send![view, addSubview:entry];

    // Initialize state
    let state = Rc::new(PillState {
        phase: Cell::new(Phase::Idle),
        visibility: Cell::new(Visibility::WhileActive),
        expand_t: Cell::new(0.0),
        expand_velocity: Cell::new(0.0),
        hovered: Cell::new(false),
        wave_phase: Cell::new(0.0),
        current_level: Cell::new(0.0),
        target_level: Cell::new(0.0),
        loading_offset: Cell::new(0.0),
        pending_levels: RefCell::new(Vec::new()),
        style_count: Cell::new(0),
        style_name: RefCell::new(String::new()),
        tooltip_t: Cell::new(0.0),
        tooltip_velocity: Cell::new(0.0),
        tooltip_width: Cell::new(0.0),
        ui_scale,
        window_mode: Cell::new(WindowMode::Dictation),
        draw_width: Cell::new(DICTATION_WINDOW_WIDTH as f64),
        draw_height: Cell::new(DICTATION_WINDOW_HEIGHT as f64),
        draw_w_velocity: Cell::new(0.0),
        draw_h_velocity: Cell::new(0.0),
        assistant_active: Cell::new(false),
        assistant_input_mode: RefCell::new("voice".to_string()),
        assistant_compact: Cell::new(true),
        assistant_conversation_id: RefCell::new(None),
        assistant_user_prompt: RefCell::new(None),
        assistant_messages: RefCell::new(Vec::new()),
        assistant_streaming: RefCell::new(None),
        assistant_permissions: RefCell::new(Vec::new()),
        panel_open_t: Cell::new(0.0),
        panel_open_velocity: Cell::new(0.0),
        kb_button_t: Cell::new(0.0),
        kb_button_velocity: Cell::new(0.0),
        shimmer_phase: Cell::new(0.0),
        scroll_offset: Cell::new(0.0),
        content_height: Cell::new(0.0),
        viewport_height: Cell::new(0.0),
        should_stick: Cell::new(true),
        click_regions: RefCell::new(Vec::new()),
        entry_text: RefCell::new(String::new()),
        cancel_t: Cell::new(0.0),
        cancel_velocity: Cell::new(0.0),
        flash_message: RefCell::new(String::new()),
        flash_visible: Cell::new(false),
        flash_t: Cell::new(0.0),
        flash_velocity: Cell::new(0.0),
        flash_timer: Cell::new(0.0),
        flash_is_error: Cell::new(false),
        flash_action: RefCell::new(None),
        flash_action_label: RefCell::new(None),
        fireworks_active: Cell::new(false),
        fireworks_elapsed: Cell::new(0.0),
        fireworks_next_launch: Cell::new(0),
        fireworks_rockets: RefCell::new(Vec::new()),
        flame_active: Cell::new(false),
        flame_elapsed: Cell::new(0.0),
        flame_tongues: RefCell::new(Vec::new()),
        flash_blue_active: Cell::new(false),
        flash_blue_elapsed: Cell::new(0.0),
        transcript_text: RefCell::new(String::new()),
        transcript_time_since_update: Cell::new(0.0),
        transcript_opacity: Cell::new(0.0),
        transcript_has_message: Cell::new(false),
    });

    // Store in thread-local
    APP_CTX.with(|cell| {
        *cell.borrow_mut() = Some(AppContext {
            state,
            receiver: RefCell::new(receiver),
            window,
            view,
            entry,
            quit: Cell::new(false),
            last_tick_time: Cell::new(0.0),
            embedded,
        });
    });

    // Set up CVDisplayLink for vsync-aligned rendering (falls back to NSTimer)
    let mut display_link: *mut c_void = std::ptr::null_mut();
    if CVDisplayLinkCreateWithActiveCGDisplays(&mut display_link) == 0 {
        CVDisplayLinkSetOutputCallback(display_link, display_link_callback, std::ptr::null_mut());
        CVDisplayLinkStart(display_link);
    } else {
        let _: id = msg_send![class!(NSTimer),
            scheduledTimerWithTimeInterval:0.016_f64
            target:view
            selector:sel!(tick:)
            userInfo:nil
            repeats:YES
        ];
    }

    // Position and show (orderFront only — don't steal focus from other apps)
    reposition_window(window);
    let _: () = msg_send![window, orderFront:nil];

    ipc::send(&OutMessage::Ready);
}

// ── Standalone binary entry point ────────────────────────────────

#[allow(dead_code)]
pub fn run(receiver: Receiver<InMessage>) {
    unsafe {
        let _pool = NSAutoreleasePool::new(nil);
        let app = NSApp();
        app.setActivationPolicy_(NSApplicationActivationPolicyAccessory);

        setup(receiver, false);

        app.run();
    }
}

// ── Embedded library entry point ─────────────────────────────────
// Hooks into the host app's existing NSApplication run loop.

#[allow(dead_code)]
pub(crate) fn run_embedded(receiver: Receiver<InMessage>) {
    unsafe {
        setup(receiver, true);
    }
}
