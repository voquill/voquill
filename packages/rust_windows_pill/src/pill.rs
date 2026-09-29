use std::cell::{Cell, RefCell};
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

use windows::core::*;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::*;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::Shell::{IVirtualDesktopManager, VirtualDesktopManager};
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::constants::*;
use crate::draw;
use crate::gfx::Gfx;
use crate::input;
use crate::ipc::{self, InMessage, OutMessage, Phase, Visibility};
use crate::state;
use crate::state::{ClickAction, PillState, Rocket, RocketPhase, Spark, WindowMode};

const TIMER_CURSOR: usize = 2;

thread_local! {
    static STATE: RefCell<Option<PillState>> = const { RefCell::new(None) };
    static GFX: RefCell<Option<Gfx>> = const { RefCell::new(None) };
    static RECEIVER: RefCell<Option<Receiver<InMessage>>> = const { RefCell::new(None) };
    static QUIT: Cell<bool> = const { Cell::new(false) };
    static LAST_TICK: Cell<Option<Instant>> = const { Cell::new(None) };
    static HWND_CELL: Cell<HWND> = const { Cell::new(HWND(std::ptr::null_mut())) };
    static TYPING_ACTIVE: Cell<bool> = const { Cell::new(false) };
    static EDIT_CONTAINER: Cell<HWND> = const { Cell::new(HWND(std::ptr::null_mut())) };
    static EDIT_HWND: Cell<HWND> = const { Cell::new(HWND(std::ptr::null_mut())) };
    static EDIT_BG_BRUSH: Cell<HBRUSH> = const { Cell::new(HBRUSH(std::ptr::null_mut())) };
    static VDM: RefCell<Option<IVirtualDesktopManager>> = const { RefCell::new(None) };
}

fn get_dpi_scale() -> f64 {
    unsafe {
        let mut cursor = POINT::default();
        if GetCursorPos(&mut cursor).is_err() {
            return 1.0;
        }
        let monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTOPRIMARY);
        let mut dpi_x: u32 = 96;
        let mut dpi_y: u32 = 96;
        let _ = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
        (dpi_x as f64 / 96.0).max(1.0)
    }
}

pub fn run(receiver: Receiver<InMessage>) {
    let t0 = Instant::now();
    unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_APARTMENTTHREADED);
        let _ = windows::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(
            windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        );
    }

    let ui_scale = get_dpi_scale();
    let window_w = (WINDOW_W_TYPING as f64 * ui_scale) as i32;
    let window_h = (WINDOW_H_TYPING as f64 * ui_scale) as i32;
    eprintln!("[pill] DPI scale: {ui_scale}, window: {window_w}x{window_h}");

    let class_name = w!("VoquillPill");
    let hinstance = unsafe { GetModuleHandleW(None).unwrap() };

    let wc = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(wndproc),
        hInstance: hinstance.into(),
        lpszClassName: class_name,
        hCursor: unsafe { LoadCursorW(None, IDC_ARROW).unwrap_or_default() },
        ..Default::default()
    };
    unsafe { RegisterClassExW(&wc); }

    let (wx, wy) = initial_position(ui_scale);
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class_name,
            w!("VoquillPill"),
            WS_POPUP,
            wx, wy,
            window_w, window_h,
            None, None, Some(hinstance.into()), None,
        ).unwrap()
    };

    HWND_CELL.with(|c| c.set(hwnd));
    eprintln!("[pill] window created in {:?}", t0.elapsed());

    let gfx = Gfx::new(window_w, window_h).expect("Failed to create D2D context");
    eprintln!("[pill] D2D/DWrite initialized in {:?}", t0.elapsed());

    let state = PillState {
        ui_scale: Cell::new(ui_scale),
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
        mouse_x: Cell::new(-1000.0),
        mouse_y: Cell::new(-1000.0),
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
        dirty: Cell::new(true),
    };

    STATE.with(|s| *s.borrow_mut() = Some(state));
    GFX.with(|g| *g.borrow_mut() = Some(gfx));
    RECEIVER.with(|r| *r.borrow_mut() = Some(receiver));

    // Initialize Virtual Desktop Manager so the pill follows across desktops
    match unsafe { CoCreateInstance(&VirtualDesktopManager, None, CLSCTX_INPROC_SERVER) } {
        Ok(vdm) => VDM.with(|c| *c.borrow_mut() = Some(vdm)),
        Err(e) => eprintln!("[pill] VirtualDesktopManager unavailable: {e:?}"),
    }

    create_edit_overlay(hinstance, hwnd);
    eprintln!("[pill] edit overlay created in {:?}", t0.elapsed());

    unsafe {
        windows::Win32::Media::timeBeginPeriod(1);
        SetTimer(Some(hwnd), TIMER_CURSOR, 60, None);
    }

    eprintln!("[pill] ready after {:?}", t0.elapsed());
    ipc::send(&OutMessage::Ready);

    unsafe {
        let mut msg = MSG::default();
        let frame_interval = Duration::from_micros(16667); // ~60fps
        loop {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_QUIT {
                    windows::Win32::Media::timeEndPeriod(1);
                    windows::Win32::System::Com::CoUninitialize();
                    return;
                }
                if handle_edit_message(&msg) { continue; }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if QUIT.with(|q| q.get()) { break; }

            on_anim_tick(hwnd);

            let elapsed = Instant::now().duration_since(
                LAST_TICK.with(|c| c.get()).unwrap_or_else(Instant::now),
            );
            if let Some(remaining) = frame_interval.checked_sub(elapsed) {
                std::thread::sleep(remaining);
            }
        }
        windows::Win32::Media::timeEndPeriod(1);
        windows::Win32::System::Com::CoUninitialize();
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_TIMER => {
            let timer_id = wparam.0;
            if timer_id == TIMER_CURSOR {
                on_cursor_tick(hwnd);
            }
            LRESULT(0)
        }
        WM_MOUSEMOVE => {
            let raw_x = (lparam.0 & 0xFFFF) as i16 as f64;
            let raw_y = ((lparam.0 >> 16) & 0xFFFF) as i16 as f64;
            STATE.with(|s| {
                if let Some(ref state) = *s.borrow() {
                    let scale = state.ui_scale.get();
                    let (ox, oy) = state.content_offset();
                    let x = raw_x / scale - ox;
                    let y = raw_y / scale - oy;
                    state.mouse_x.set(x);
                    state.mouse_y.set(y);
                    let regions = state.click_regions.borrow();
                    let hit = regions.iter().rev().find(|r| r.contains(x, y));
                    let cursor_id = match hit {
                        Some(r) if matches!(r.action, ClickAction::InputField) => IDC_IBEAM,
                        Some(_) => IDC_HAND,
                        None => IDC_ARROW,
                    };
                    unsafe { SetCursor(LoadCursorW(None, cursor_id).ok()); }
                }
            });
            LRESULT(0)
        }
        WM_SETCURSOR => {
            let hit_test = (lparam.0 & 0xFFFF) as i16;
            if hit_test == 1 { // HTCLIENT
                LRESULT(1)
            } else {
                unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
            }
        }
        WM_LBUTTONDOWN => {
            STATE.with(|s| {
                if let Some(ref state) = *s.borrow() {
                    if state.assistant_active.get()
                        && *state.assistant_input_mode.borrow() == "type"
                    {
                        focus_edit_control();
                    }
                }
            });
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            let raw_x = (lparam.0 & 0xFFFF) as i16 as f64;
            let raw_y = ((lparam.0 >> 16) & 0xFFFF) as i16 as f64;
            STATE.with(|s| {
                if let Some(ref state) = *s.borrow() {
                    let scale = state.ui_scale.get();
                    input::handle_click(state, raw_x / scale, raw_y / scale);
                }
            });
            LRESULT(0)
        }
        WM_MOUSEWHEEL => {
            let delta = ((wparam.0 >> 16) & 0xFFFF) as i16 as f64;
            let scroll = -delta / 120.0 * 30.0;
            STATE.with(|s| {
                if let Some(ref state) = *s.borrow() {
                    input::handle_scroll(state, scroll);
                }
            });
            LRESULT(0)
        }
        WM_CHAR => {
            let ch = char::from_u32(wparam.0 as u32);
            if let Some(ch) = ch {
                STATE.with(|s| {
                    if let Some(ref state) = *s.borrow() {
                        if ch == '\r' || ch == '\n' {
                            let text = state.entry_text.borrow().trim().to_string();
                            if !text.is_empty() {
                                ipc::send(&OutMessage::TypedMessage { text });
                                *state.entry_text.borrow_mut() = String::new();
                            }
                        } else if ch == '\u{8}' {
                            // Backspace
                            let mut t = state.entry_text.borrow_mut();
                            t.pop();
                        } else if !ch.is_control() {
                            state.entry_text.borrow_mut().push(ch);
                        }
                    }
                });
            }
            LRESULT(0)
        }
        WM_KEYDOWN => {
            if wparam.0 == VK_ESCAPE.0 as usize {
                STATE.with(|s| {
                    if let Some(ref state) = *s.borrow() {
                        if state.assistant_active.get()
                            && *state.assistant_input_mode.borrow() == "type"
                        {
                            ipc::send(&OutMessage::AssistantClose);
                        }
                    }
                });
            }
            LRESULT(0)
        }
        WM_DESTROY => {
            unsafe { PostQuitMessage(0); }
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

fn on_anim_tick(hwnd: HWND) {
    RECEIVER.with(|r| {
        STATE.with(|s| {
            if let (Some(ref rx), Some(ref state)) = (&*r.borrow(), &*s.borrow()) {
                while let Ok(msg) = rx.try_recv() {
                    process_message(msg, state, hwnd);
                }
            }
        });
    });

    if QUIT.with(|q| q.get()) {
        unsafe { DestroyWindow(hwnd).ok(); }
        return;
    }

    let now = Instant::now();
    let dt = LAST_TICK.with(|cell| {
        let prev = cell.get();
        cell.set(Some(now));
        match prev {
            Some(prev) => now.duration_since(prev).as_secs_f64().clamp(0.001, 0.05),
            None => 1.0 / 60.0,
        }
    });

    STATE.with(|s| {
        if let Some(ref state) = *s.borrow() {
            tick(state, dt);
            update_visibility(hwnd, state);
            update_typing_focus(hwnd, state);
        }
    });

    GFX.with(|g| {
        STATE.with(|s| {
            if let (Some(ref mut gfx), Some(ref state)) = (&mut *g.borrow_mut(), &*s.borrow()) {
                if state.needs_redraw() {
                    state.dirty.set(false);
                    draw::draw_all(gfx, state);
                    update_layered(hwnd, gfx);
                }
                update_edit_overlay(hwnd, state);
            }
        });
    });
}

fn on_cursor_tick(hwnd: HWND) {
    STATE.with(|s| {
        if let Some(ref state) = *s.borrow() {
            check_hover(hwnd, state);
            reposition_to_cursor_monitor(hwnd);
        }
    });
    ensure_on_current_desktop(hwnd);
}

fn ensure_on_current_desktop(hwnd: HWND) {
    VDM.with(|v| {
        let vdm_guard = v.borrow();
        let vdm = match &*vdm_guard {
            Some(ref vdm) => vdm,
            None => return,
        };
        let result: windows::core::Result<windows::core::BOOL> =
            unsafe { vdm.IsWindowOnCurrentVirtualDesktop(hwnd) };
        if let Ok(is_on_current) = result {
            if !is_on_current.as_bool() {
                // Create a temporary window on the current desktop to get its GUID
                if let Ok(temp_hwnd) = unsafe {
                    CreateWindowExW(
                        WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                        w!("STATIC"),
                        w!(""),
                        WS_POPUP,
                        0, 0, 1, 1,
                        None, None, None, None,
                    )
                } {
                    if let Ok(cur_desktop_id) =
                        unsafe { vdm.GetWindowDesktopId(temp_hwnd) }
                    {
                        unsafe {
                            let _ = vdm.MoveWindowToDesktop(hwnd, &cur_desktop_id);
                        }
                    }
                    unsafe { let _ = DestroyWindow(temp_hwnd); }
                }
            }
        }
    });
}

fn process_message(msg: InMessage, state: &PillState, _hwnd: HWND) {
    state.dirty.set(true);
    match msg {
        InMessage::Phase { phase } => {
            let prev = state.phase.get();
            state.phase.set(phase);
            if phase == Phase::Idle && prev != Phase::Idle {
                state.target_level.set(0.0);
                state.current_level.set(0.0);
                state.wave_phase.set(0.0);
            }
        }
        InMessage::Levels { levels } => {
            *state.pending_levels.borrow_mut() = levels;
        }
        InMessage::StyleInfo { count, name } => {
            state.style_count.set(count);
            *state.style_name.borrow_mut() = name;
        }
        InMessage::Toast { message, toast_type, duration, action, action_label } => {
            *state.flash_message.borrow_mut() = message;
            state.flash_is_error.set(toast_type.as_deref() == Some("error"));
            state.flash_visible.set(true);
            state.flash_timer.set(duration.unwrap_or(FLASH_DURATION));
            *state.flash_action.borrow_mut() = action;
            *state.flash_action_label.borrow_mut() = action_label;
        }
        InMessage::DismissToast => {
            state.flash_visible.set(false);
            state.flash_timer.set(0.0);
            *state.flash_action.borrow_mut() = None;
            *state.flash_action_label.borrow_mut() = None;
        }
        InMessage::Fireworks { message } => {
            *state.flash_message.borrow_mut() = message;
            state.flash_is_error.set(false);
            *state.flash_action.borrow_mut() = None;
            *state.flash_action_label.borrow_mut() = None;
            state.flash_visible.set(true);
            state.flash_timer.set(FIREWORKS_TOTAL_DURATION);
            state.fireworks_active.set(true);
            state.fireworks_elapsed.set(0.0);
            state.fireworks_next_launch.set(0);
            state.fireworks_rockets.borrow_mut().clear();
        }
        InMessage::Flame { message } => {
            *state.flash_message.borrow_mut() = message;
            state.flash_is_error.set(false);
            *state.flash_action.borrow_mut() = None;
            *state.flash_action_label.borrow_mut() = None;
            state.flash_visible.set(true);
            state.flash_timer.set(FLAME_TOTAL_DURATION);

            state.flame_active.set(true);
            state.flame_elapsed.set(0.0);
            state.flame_tongues.borrow_mut().clear();
        }
        InMessage::FlashBlue => {
            state.flash_blue_active.set(true);
            state.flash_blue_elapsed.set(0.0);
        }
        InMessage::BroadcastTranscript { text } => {
            *state.transcript_text.borrow_mut() = text;
            state.transcript_time_since_update.set(0.0);
            state.transcript_has_message.set(true);
        }
        InMessage::Visibility { visibility } => {
            state.visibility.set(visibility);
        }
        InMessage::WindowSize { ref size } => {
            state.window_mode.set(WindowMode::from_str(size));
        }
        InMessage::AssistantState {
            active, input_mode, compact,
            conversation_id, user_prompt,
            messages, streaming, permissions,
        } => {
            let was_active = state.assistant_active.get();
            state.assistant_active.set(active);
            *state.assistant_input_mode.borrow_mut() = input_mode;
            state.assistant_compact.set(compact);
            *state.assistant_conversation_id.borrow_mut() = conversation_id;
            *state.assistant_user_prompt.borrow_mut() = user_prompt;
            *state.assistant_messages.borrow_mut() = messages;
            *state.assistant_streaming.borrow_mut() = streaming;
            *state.assistant_permissions.borrow_mut() = permissions;
            if active && !was_active {
                state.should_stick.set(true);
                state.scroll_offset.set(0.0);
            }
        }
        InMessage::Quit => {
            QUIT.with(|q| q.set(true));
        }
    }
}

fn tick(state: &PillState, dt: f64) {
    let phase = state.phase.get();
    let is_active = phase != Phase::Idle;
    let is_recording = phase == Phase::Recording;
    let is_loading = phase == Phase::Loading;
    let hovered = state.hovered.get();
    let frame_scale = dt * 60.0;

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

    let expand_target = if is_active || hovered || state.assistant_active.get() { 1.0 } else { 0.0 };
    spring_anim(&state.expand_t, &state.expand_velocity, expand_target, SPRING_STIFFNESS, dt);

    if is_loading {
        state.loading_offset.set((state.loading_offset.get() + LOADING_SPEED * frame_scale) % 1.0);
    }

    let show_tooltip = !state.assistant_active.get()
        && state.style_count.get() > 1
        && (hovered || phase == Phase::Recording)
        && state.expand_t.get() > 0.3;
    let tooltip_target = if show_tooltip { 1.0 } else { 0.0 };
    spring_anim(&state.tooltip_t, &state.tooltip_velocity, tooltip_target, SPRING_STIFFNESS, dt);

    let panel_target = if state.assistant_active.get() { 1.0 } else { 0.0 };
    spring_anim(&state.panel_open_t, &state.panel_open_velocity, panel_target, SPRING_STIFFNESS, dt);

    let is_voice = *state.assistant_input_mode.borrow() == "voice";
    let kb_target = if state.assistant_active.get() && is_voice { 1.0 } else { 0.0 };
    spring_anim(&state.kb_button_t, &state.kb_button_velocity, kb_target, SPRING_STIFFNESS, dt);

    let mode = state.window_mode.get();
    let (tw, th) = mode.dimensions();
    spring_px(&state.draw_width, &state.draw_w_velocity, tw as f64, SPRING_STIFFNESS, dt);
    spring_px(&state.draw_height, &state.draw_h_velocity, th as f64, SPRING_STIFFNESS, dt);

    state.shimmer_phase.set((state.shimmer_phase.get() + SHIMMER_SPEED * frame_scale) % 1.0);

    tick_fireworks(state, dt);
    tick_flame(state, dt);
    tick_flash_blue(state, dt);
    tick_transcript(state, dt);

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

    if state.should_stick.get() && state.assistant_active.get() && !state.assistant_compact.get() {
        let max_scroll = (state.content_height.get() - state.viewport_height.get()).max(0.0);
        state.scroll_offset.set(max_scroll);
    }
}

fn tick_fireworks(state: &PillState, dt: f64) {
    if !state.fireworks_active.get() { return; }

    let elapsed = state.fireworks_elapsed.get() + dt;
    state.fireworks_elapsed.set(elapsed);

    let ww = state.draw_width.get();
    let wh = state.draw_height.get();
    let (_, pill_y, _, _) = draw::pill_position(state, ww, wh);
    let origin_x = ww / 2.0;
    let origin_y = pill_y - FLASH_GAP - FLASH_HEIGHT / 2.0;

    let mut next = state.fireworks_next_launch.get();
    let mut rockets = state.fireworks_rockets.borrow_mut();

    while next < FIREWORK_LAUNCHES.len() && elapsed >= FIREWORK_LAUNCHES[next].time {
        let launch = &FIREWORK_LAUNCHES[next];
        let angle_rad = launch.angle_deg.to_radians();
        let color = FIREWORK_COLORS[next % FIREWORK_COLORS.len()];
        rockets.push(Rocket {
            x: origin_x, y: origin_y,
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
                            x: rocket.x, y: rocket.y,
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
                if rocket.trail_alpha < 0.0 { rocket.trail_alpha = 0.0; }
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

            tongues.push(state::FlameTongue {
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

fn update_visibility(hwnd: HWND, state: &PillState) {
    let visibility = state.visibility.get();
    let is_active = state.phase.get() != Phase::Idle;
    let is_assistant = state.assistant_active.get();

    let should_show = match visibility {
        Visibility::Hidden => is_assistant,
        Visibility::WhileActive => is_active || is_assistant,
        Visibility::Persistent => true,
    };

    unsafe {
        if should_show {
            if !IsWindowVisible(hwnd).as_bool() {
                ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            }
        } else if IsWindowVisible(hwnd).as_bool() {
            ShowWindow(hwnd, SW_HIDE);
        }
    }
}

fn update_typing_focus(_hwnd: HWND, state: &PillState) {
    let is_typing = state.assistant_active.get()
        && *state.assistant_input_mode.borrow() == "type";
    let was_typing = TYPING_ACTIVE.with(|t| t.get());

    if is_typing && !was_typing {
        TYPING_ACTIVE.with(|t| t.set(true));
        // Sync any existing text to the Edit control and focus it
        let text = state.entry_text.borrow().clone();
        set_edit_text(&text);
        focus_edit_control();
    } else if !is_typing && was_typing {
        TYPING_ACTIVE.with(|t| t.set(false));
        clear_edit_control();
    }
}

fn check_hover(hwnd: HWND, state: &PillState) {
    let mut cursor = POINT::default();
    unsafe { let _ = GetCursorPos(&mut cursor); }

    let mut win_rect = RECT::default();
    unsafe { let _ = GetWindowRect(hwnd, &mut win_rect); }

    let scale = state.ui_scale.get();
    let (ox, oy) = state.content_offset();
    let dw = state.draw_width.get();
    let dh = state.draw_height.get();

    // Pill position in screen coordinates (DIP → physical)
    let (pill_x, pill_y, pill_w, pill_h) = draw::pill_position(state, dw, dh);
    let screen_pill_x = win_rect.left as f64 + (ox + pill_x) * scale;
    let screen_pill_y = win_rect.top as f64 + (oy + pill_y) * scale;
    let screen_pill_w = pill_w * scale;
    let screen_pill_h = pill_h * scale;

    let pad = (if state.hovered.get() { 24.0 } else { 8.0 }) * scale;
    let cx = cursor.x as f64;
    let cy = cursor.y as f64;

    let in_pill = cx >= screen_pill_x - pad
        && cx <= screen_pill_x + screen_pill_w + pad
        && cy >= screen_pill_y - pad
        && cy <= screen_pill_y + screen_pill_h + pad;

    let in_panel = if state.assistant_active.get() {
        let panel_x = win_rect.left as f64 + ox * scale;
        let panel_y = win_rect.top as f64 + oy * scale;
        cx >= panel_x && cx <= panel_x + dw * scale
            && cy >= panel_y && cy <= panel_y + dh * scale
    } else {
        false
    };

    let new_hovered = in_pill || in_panel;
    let was_hovered = state.hovered.get();

    if new_hovered != was_hovered {
        state.hovered.set(new_hovered);
        state.dirty.set(true);
        ipc::send(&OutMessage::Hover { hovered: new_hovered });
    }
    if !new_hovered {
        state.mouse_x.set(-1000.0);
        state.mouse_y.set(-1000.0);
    }
}

fn update_layered(hwnd: HWND, gfx: &Gfx) {
    unsafe {
        let size = SIZE { cx: gfx.width, cy: gfx.height };
        let src_point = POINT { x: 0, y: 0 };
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        let _ = UpdateLayeredWindow(
            hwnd,
            None,
            None,
            Some(&size),
            Some(gfx.hdc),
            Some(&src_point),
            COLORREF(0),
            Some(&blend),
            ULW_ALPHA,
        );
    }
}

fn initial_position(ui_scale: f64) -> (i32, i32) {
    unsafe {
        let mut cursor = POINT::default();
        let _ = GetCursorPos(&mut cursor);
        let monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTOPRIMARY);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        let _ = GetMonitorInfoW(monitor, &mut info);
        let wa = info.rcWork;
        let wa_w = wa.right - wa.left;
        let wa_h = wa.bottom - wa.top;
        let win_w = (WINDOW_W_TYPING as f64 * ui_scale) as i32;
        let win_h = (WINDOW_H_TYPING as f64 * ui_scale) as i32;
        let margin = (MARGIN_BOTTOM as f64 * ui_scale) as i32;
        let x = wa.left + (wa_w - win_w) / 2;
        let y = wa.top + wa_h - win_h - margin;
        (x, y)
    }
}

fn reposition_to_cursor_monitor(hwnd: HWND) {
    unsafe {
        let mut cursor = POINT::default();
        let _ = GetCursorPos(&mut cursor);
        let monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTOPRIMARY);

        let mut dpi_x: u32 = 96;
        let mut dpi_y: u32 = 96;
        let _ = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
        let new_scale = (dpi_x as f64 / 96.0).max(1.0);

        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        let _ = GetMonitorInfoW(monitor, &mut info);
        let wa = info.rcWork;
        let wa_w = wa.right - wa.left;
        let wa_h = wa.bottom - wa.top;

        let win_w = (WINDOW_W_TYPING as f64 * new_scale) as i32;
        let win_h = (WINDOW_H_TYPING as f64 * new_scale) as i32;
        let margin = (MARGIN_BOTTOM as f64 * new_scale) as i32;
        let x = wa.left + (wa_w - win_w) / 2;
        let y = wa.top + wa_h - win_h - margin;

        let mut current = RECT::default();
        let _ = GetWindowRect(hwnd, &mut current);
        let cur_w = current.right - current.left;
        let cur_h = current.bottom - current.top;

        let scale_changed = STATE.with(|s| {
            if let Some(ref state) = *s.borrow() {
                let old = state.ui_scale.get();
                (new_scale - old).abs() > 0.01
            } else {
                false
            }
        });

        if scale_changed || current.left != x || current.top != y || cur_w != win_w || cur_h != win_h {
            // Update window position and size
            let flags = if scale_changed {
                SWP_NOZORDER | SWP_NOACTIVATE
            } else {
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
            };
            let _ = SetWindowPos(hwnd, None, x, y, win_w, win_h, flags);

            if scale_changed {
                STATE.with(|s| {
                    if let Some(ref state) = *s.borrow() {
                        state.ui_scale.set(new_scale);
                        state.dirty.set(true);
                    }
                });
                GFX.with(|g| {
                    if let Some(ref mut gfx) = *g.borrow_mut() {
                        gfx.resize(win_w, win_h);
                    }
                });
            }
        }
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

// ── Native text input overlay ────────────────────────────────────────

const ES_AUTOHSCROLL: u32 = 0x0080;
const EN_CHANGE_NOTIFICATION: u16 = 0x0300;
const EM_SETMARGINS: u32 = 0x00D3;
const EM_GETSEL: u32 = 0x00B0;
const EM_SETSEL: u32 = 0x00B1;
const EM_REPLACESEL: u32 = 0x00C2;
const EC_LEFTMARGIN: u32 = 1;
const EC_RIGHTMARGIN: u32 = 2;
const EDIT_COLOR_KEY: u32 = 0x00010001; // RGB(1,0,1) - unique color for transparency
const EDIT_TEXT_COLOR: u32 = 0x00E8E8E8; // RGB(232, 232, 232)

fn create_edit_overlay(hinstance: HMODULE, main_hwnd: HWND) {
    unsafe {
        let brush = CreateSolidBrush(COLORREF(EDIT_COLOR_KEY));
        EDIT_BG_BRUSH.with(|b| b.set(brush));

        let class_name = w!("VoquillInput");
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(edit_container_proc),
            hInstance: hinstance.into(),
            lpszClassName: class_name,
            hbrBackground: brush,
            ..Default::default()
        };
        RegisterClassExW(&wc);

        let container = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED,
            class_name,
            w!(""),
            WS_POPUP | WS_CLIPCHILDREN,
            0, 0, 400, PANEL_INPUT_HEIGHT as i32,
            Some(main_hwnd),
            None,
            Some(hinstance.into()),
            None,
        ).unwrap();

        let edit = CreateWindowExW(
            WS_EX_LEFT,
            w!("EDIT"),
            w!(""),
            WINDOW_STYLE(WS_CHILD.0 | WS_VISIBLE.0 | ES_AUTOHSCROLL),
            0, 0, 400, PANEL_INPUT_HEIGHT as i32,
            Some(container),
            None,
            Some(hinstance.into()),
            None,
        ).unwrap();

        // Font: Segoe UI ~14pt
        let mut lf = LOGFONTW::default();
        lf.lfHeight = -18;
        lf.lfWeight = 400;
        let face: Vec<u16> = "Segoe UI".encode_utf16().collect();
        lf.lfFaceName[..face.len()].copy_from_slice(&face);
        let font = CreateFontIndirectW(&lf);
        SendMessageW(edit, WM_SETFONT, Some(WPARAM(font.0 as usize)), Some(LPARAM(1)));

        // Set internal margins
        let margins = (8u32 as isize) | ((8u32 as isize) << 16);
        SendMessageW(edit, EM_SETMARGINS, Some(WPARAM((EC_LEFTMARGIN | EC_RIGHTMARGIN) as usize)), Some(LPARAM(margins)));

        EDIT_CONTAINER.with(|c| c.set(container));
        EDIT_HWND.with(|e| e.set(edit));
    }
}

unsafe extern "system" fn edit_container_proc(
    hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_CTLCOLOREDIT => {
            let hdc = HDC(wparam.0 as *mut std::ffi::c_void);
            SetTextColor(hdc, COLORREF(EDIT_TEXT_COLOR));
            SetBkMode(hdc, TRANSPARENT);
            let brush = EDIT_BG_BRUSH.with(|b| b.get());
            LRESULT(brush.0 as isize)
        }
        WM_COMMAND => {
            let notification = ((wparam.0 >> 16) & 0xFFFF) as u16;
            if notification == EN_CHANGE_NOTIFICATION {
                // Sync native Edit text → state.entry_text
                let text = get_edit_text();
                STATE.with(|s| {
                    if let Some(ref state) = *s.borrow() {
                        *state.entry_text.borrow_mut() = text;
                    }
                });
            }
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// Intercepts messages for the Edit control before TranslateMessage/DispatchMessage.
/// Returns true if the message was consumed and should not be dispatched.
fn handle_edit_message(msg: &MSG) -> bool {
    let edit = EDIT_HWND.with(|e| e.get());
    if msg.hwnd != edit { return false; }

    match msg.message {
        WM_KEYDOWN => {
            let ctrl = unsafe { (GetKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000) != 0 };

            if msg.wParam.0 == VK_RETURN.0 as usize {
                // Send the typed message
                STATE.with(|s| {
                    if let Some(ref state) = *s.borrow() {
                        let text = state.entry_text.borrow().trim().to_string();
                        if !text.is_empty() {
                            ipc::send(&OutMessage::TypedMessage { text });
                            *state.entry_text.borrow_mut() = String::new();
                        }
                    }
                });
                unsafe { let _ = SetWindowTextW(edit, w!("")); }
                return true;
            } else if msg.wParam.0 == VK_ESCAPE.0 as usize {
                ipc::send(&OutMessage::AssistantClose);
                return true;
            } else if ctrl && msg.wParam.0 == 'A' as usize {
                // Select all
                unsafe { SendMessageW(edit, EM_SETSEL, Some(WPARAM(0)), Some(LPARAM(-1))); }
                return true;
            } else if ctrl && msg.wParam.0 == VK_BACK.0 as usize {
                ctrl_backspace(edit);
                return true;
            }
            false
        }
        _ => false,
    }
}

fn ctrl_backspace(edit: HWND) {
    unsafe {
        // Get caret position from return value: LOWORD=start, HIWORD=end
        let result = SendMessageW(edit, EM_GETSEL, None, None);
        let caret = ((result.0 >> 16) & 0xFFFF) as usize;
        if caret == 0 { return; }

        // Get text as UTF-16
        let len = GetWindowTextLengthW(edit);
        if len == 0 { return; }
        let mut buf = vec![0u16; (len + 1) as usize];
        GetWindowTextW(edit, &mut buf);

        let mut pos = caret.min(len as usize);

        // Skip whitespace backwards
        while pos > 0 && (buf[pos - 1] == b' ' as u16 || buf[pos - 1] == b'\t' as u16) {
            pos -= 1;
        }
        // Skip non-whitespace backwards
        while pos > 0 && buf[pos - 1] != b' ' as u16 && buf[pos - 1] != b'\t' as u16 {
            pos -= 1;
        }

        // Select from word start to caret and replace with empty
        SendMessageW(edit, EM_SETSEL, Some(WPARAM(pos)), Some(LPARAM(caret as isize)));
        let empty: [u16; 1] = [0];
        SendMessageW(edit, EM_REPLACESEL, Some(WPARAM(1)), Some(LPARAM(empty.as_ptr() as isize)));
    }
}

fn update_edit_overlay(main_hwnd: HWND, state: &PillState) {
    let is_typing = state.assistant_active.get()
        && *state.assistant_input_mode.borrow() == "type";
    let container = EDIT_CONTAINER.with(|c| c.get());
    let edit = EDIT_HWND.with(|e| e.get());

    if !is_typing {
        unsafe {
            if IsWindowVisible(container).as_bool() {
                ShowWindow(container, SW_HIDE);
            }
        }
        return;
    }

    let scale = state.ui_scale.get();

    // Calculate input field position in screen coordinates
    let (ox, oy) = state.content_offset();
    let ww = state.draw_width.get();
    let wh = state.draw_height.get();

    let panel_w = PANEL_EXPANDED_WIDTH;
    let panel_x = (ww - panel_w) / 2.0;
    let panel_h = wh - PANEL_TOP_MARGIN as f64 - PANEL_BOTTOM_MARGIN as f64;
    let y_shift = (1.0 - state.panel_open_t.get()) * 12.0;
    let py = PANEL_TOP_MARGIN as f64 + y_shift;
    let input_y = py + panel_h - PANEL_INPUT_HEIGHT;
    let input_x = panel_x + PANEL_CONTENT_SIDE_INSET;
    let send_btn_size = 28.0_f64;
    let input_w = panel_w - PANEL_CONTENT_SIDE_INSET * 2.0 - send_btn_size - 8.0;

    let mut win_rect = RECT::default();
    unsafe { let _ = GetWindowRect(main_hwnd, &mut win_rect); }

    let screen_x = win_rect.left as f64 + (ox + input_x) * scale;
    let screen_y = win_rect.top as f64 + (oy + input_y + 1.0) * scale;
    let h = ((PANEL_INPUT_HEIGHT - 1.0) * scale) as i32;
    let w = (input_w * scale) as i32;

    unsafe {
        // Color key makes the background transparent; alpha matches text to panel opacity
        let alpha = (state.panel_open_t.get() * PANEL_BG_ALPHA * 255.0) as u8;
        let _ = SetLayeredWindowAttributes(
            container, COLORREF(EDIT_COLOR_KEY), alpha,
            LWA_COLORKEY | LWA_ALPHA,
        );

        let _ = SetWindowPos(
            container, None,
            screen_x as i32, screen_y as i32,
            w, h,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
        let _ = SetWindowPos(
            edit, None,
            0, 0,
            w, h,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOMOVE,
        );
    }

    // If state.entry_text was cleared externally (e.g. send button), sync to Edit
    let state_text = state.entry_text.borrow().clone();
    let edit_text = get_edit_text();
    if state_text.is_empty() && !edit_text.is_empty() {
        set_edit_text("");
    }
}

fn get_edit_text() -> String {
    let edit = EDIT_HWND.with(|e| e.get());
    unsafe {
        let len = GetWindowTextLengthW(edit);
        if len == 0 { return String::new(); }
        let mut buf = vec![0u16; (len + 1) as usize];
        GetWindowTextW(edit, &mut buf);
        String::from_utf16_lossy(&buf[..len as usize])
    }
}

fn set_edit_text(text: &str) {
    let edit = EDIT_HWND.with(|e| e.get());
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { let _ = SetWindowTextW(edit, PCWSTR(wide.as_ptr())); }
}

pub(crate) fn clear_edit_control() {
    set_edit_text("");
}

pub(crate) fn focus_edit_control() {
    let container = EDIT_CONTAINER.with(|c| c.get());
    let edit = EDIT_HWND.with(|e| e.get());
    unsafe {
        let _ = SetForegroundWindow(container);
        let _ = SetFocus(Some(edit));
    }
}
