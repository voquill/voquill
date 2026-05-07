//! Direct Java Access Bridge (JAB) DLL interop.
//!
//! When UIAutomation can't see Swing components (JAB not registered in System32),
//! we load windowsaccessbridge-64.dll from the JDK bin directory and call
//! the JAB C API directly to walk the accessibility tree.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use windows::core::{HSTRING, PCSTR};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetWindowThreadProcessId, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
};

const MAX_STRING_SIZE: usize = 1024;
const SHORT_STRING_SIZE: usize = 256;
const MAX_JAB_DEPTH: usize = 30;
const MAX_JAB_ELEMENTS: usize = 5000;

type JOBJECT64 = i64;

#[repr(C)]
pub struct AccessibleContextInfo {
    pub name: [u16; MAX_STRING_SIZE],
    pub description: [u16; MAX_STRING_SIZE],
    pub role: [u16; SHORT_STRING_SIZE],
    pub role_en_us: [u16; SHORT_STRING_SIZE],
    pub states: [u16; SHORT_STRING_SIZE],
    pub states_en_us: [u16; SHORT_STRING_SIZE],
    pub index_in_parent: i32,
    pub children_count: i32,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub accessible_component: i32,
    pub accessible_action: i32,
    pub accessible_selection: i32,
    pub accessible_text: i32,
    pub accessible_interfaces: i32,
}

#[repr(C)]
pub struct AccessibleTextInfo {
    pub char_count: i32,
    pub caret_index: i32,
    pub index_at_point: i32,
}

// Function pointer types matching the JAB C API
type WindowsRunFn = unsafe extern "C" fn() -> i32;
type GetContextFromHwndFn = unsafe extern "C" fn(HWND, *mut i32, *mut JOBJECT64) -> i32;
type GetContextWithFocusFn = unsafe extern "C" fn(HWND, *mut i32, *mut JOBJECT64) -> i32;
type GetContextInfoFn = unsafe extern "C" fn(i32, JOBJECT64, *mut AccessibleContextInfo) -> i32;
type GetChildFn = unsafe extern "C" fn(i32, JOBJECT64, i32) -> JOBJECT64;
type GetParentFn = unsafe extern "C" fn(i32, JOBJECT64) -> JOBJECT64;
type ReleaseObjectFn = unsafe extern "C" fn(i32, JOBJECT64);
type GetTextInfoFn = unsafe extern "C" fn(i32, JOBJECT64, *mut AccessibleTextInfo, i32, i32) -> i32;
type GetTextRangeFn = unsafe extern "C" fn(i32, JOBJECT64, i32, i32, *mut u16, i16) -> i32;
type SetTextContentsFn = unsafe extern "C" fn(i32, JOBJECT64, *const u16) -> i32;
type RequestFocusFn = unsafe extern "C" fn(i32, JOBJECT64) -> i32;
type SetCaretPositionFn = unsafe extern "C" fn(i32, JOBJECT64, i32) -> i32;

struct JabApi {
    windows_run: WindowsRunFn,
    get_context_from_hwnd: GetContextFromHwndFn,
    get_context_with_focus: GetContextWithFocusFn,
    get_context_info: GetContextInfoFn,
    get_child: GetChildFn,
    get_parent: GetParentFn,
    release_object: ReleaseObjectFn,
    get_text_info: GetTextInfoFn,
    get_text_range: GetTextRangeFn,
    set_text_contents: SetTextContentsFn,
    request_focus: RequestFocusFn,
    set_caret_position: SetCaretPositionFn,
}

fn find_jab_dll() -> Option<std::path::PathBuf> {
    // 1. JAVA_HOME environment variable
    if let Ok(java_home) = std::env::var("JAVA_HOME") {
        let path = std::path::PathBuf::from(&java_home)
            .join("bin")
            .join("windowsaccessbridge-64.dll");
        if path.exists() {
            return Some(path);
        }
    }

    // 2. `where java` on PATH
    if let Ok(output) = std::process::Command::new("where").arg("java").output() {
        if let Ok(path_str) = String::from_utf8(output.stdout) {
            if let Some(line) = path_str.lines().next() {
                if let Some(bin_dir) = std::path::Path::new(line.trim()).parent() {
                    let dll = bin_dir.join("windowsaccessbridge-64.dll");
                    if dll.exists() {
                        return Some(dll);
                    }
                }
            }
        }
    }

    // 3. Common JRE/JDK installation directories
    let program_files = [
        std::env::var("ProgramFiles").ok(),
        std::env::var("ProgramFiles(x86)").ok(),
    ];
    let java_dirs = [
        "Java",
        "Eclipse Adoptium",
        "AdoptOpenJDK",
        "Amazon Corretto",
        "Zulu",
    ];
    for pf in program_files.iter().flatten() {
        for java_dir in &java_dirs {
            let base = std::path::PathBuf::from(pf).join(java_dir);
            if let Ok(entries) = std::fs::read_dir(&base) {
                for entry in entries.flatten() {
                    let dll = entry.path().join("bin").join("windowsaccessbridge-64.dll");
                    if dll.exists() {
                        return Some(dll);
                    }
                }
            }
        }
    }

    // 4. OpenWebStart / IcedTea-Web JRE cache
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let ows_base = std::path::PathBuf::from(&local_app_data)
            .join("icedtea-web")
            .join("cache");
        if let Ok(entries) = std::fs::read_dir(&ows_base) {
            for entry in entries.flatten() {
                let dll = entry.path().join("bin").join("windowsaccessbridge-64.dll");
                if dll.exists() {
                    return Some(dll);
                }
            }
        }
    }

    None
}

/// Find the JAB DLL by examining the executable path of a running Java process.
/// This handles cases like OpenWebStart where the JRE is in a non-standard cache
/// location that isn't on PATH or in JAVA_HOME.
fn find_jab_dll_for_pid(pid: u32) -> Option<std::path::PathBuf> {
    use windows::Win32::System::ProcessStatus::GetModuleFileNameExW;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let len = GetModuleFileNameExW(Some(handle), None, &mut buf);
        let _ = windows::Win32::Foundation::CloseHandle(handle);
        if len == 0 {
            return None;
        }
        let exe_path = String::from_utf16_lossy(&buf[..len as usize]);
        let exe_dir = std::path::Path::new(&exe_path).parent()?;

        // The JAB DLL lives in the same bin/ directory as java.exe / javaw.exe
        let dll = exe_dir.join("windowsaccessbridge-64.dll");
        if dll.exists() {
            log::info!("Found JAB DLL via process PID {}: {}", pid, dll.display());
            return Some(dll);
        }

        // Some JRE layouts put the DLL in a sibling directory
        if let Some(parent) = exe_dir.parent() {
            let dll = parent.join("bin").join("windowsaccessbridge-64.dll");
            if dll.exists() {
                log::info!(
                    "Found JAB DLL via process PID {} (sibling bin): {}",
                    pid,
                    dll.display()
                );
                return Some(dll);
            }
        }

        None
    }
}

// Cached JAB API — DLL is loaded once and reused across calls.
// Two locks: standard search (JAVA_HOME, PATH, common dirs) runs once at startup.
// PID-based fallback runs once when the standard search fails and we learn a target PID.
static JAB_API_STANDARD: OnceLock<Option<JabApi>> = OnceLock::new();
static JAB_API_PID_BASED: OnceLock<Option<JabApi>> = OnceLock::new();
static JAB_BRIDGE_RUNNING: AtomicBool = AtomicBool::new(false);

#[allow(clippy::missing_transmute_annotations)]
fn load_jab_from_path(dll_path: &std::path::Path) -> Option<JabApi> {
    log::info!("Loading JAB DLL from: {}", dll_path.display());

    unsafe {
        let hmodule = LoadLibraryW(&HSTRING::from(dll_path.to_string_lossy().as_ref())).ok()?;

        macro_rules! load_fn {
            ($name:literal) => {
                std::mem::transmute(GetProcAddress(
                    hmodule,
                    PCSTR::from_raw(concat!($name, "\0").as_ptr()),
                )?)
            };
        }

        Some(JabApi {
            windows_run: load_fn!("Windows_run"),
            get_context_from_hwnd: load_fn!("getAccessibleContextFromHWND"),
            get_context_with_focus: load_fn!("getAccessibleContextWithFocus"),
            get_context_info: load_fn!("getAccessibleContextInfo"),
            get_child: load_fn!("getAccessibleChildFromContext"),
            get_parent: load_fn!("getAccessibleParentFromContext"),
            release_object: load_fn!("releaseJavaObject"),
            get_text_info: load_fn!("getAccessibleTextInfo"),
            get_text_range: load_fn!("getAccessibleTextRange"),
            set_text_contents: load_fn!("setTextContents"),
            request_focus: load_fn!("requestFocus"),
            set_caret_position: load_fn!("setCaretPosition"),
        })
    }
}

fn get_jab_api(hint_pid: Option<u32>) -> Option<&'static JabApi> {
    // Try standard search (JAVA_HOME, PATH, common install dirs)
    let standard =
        JAB_API_STANDARD.get_or_init(|| find_jab_dll().and_then(|p| load_jab_from_path(&p)));
    if standard.is_some() {
        return standard.as_ref();
    }

    // Standard search failed — try finding the DLL from the target process.
    // This handles OpenWebStart and other launchers that bundle JREs in
    // non-standard cache directories.
    if let Some(pid) = hint_pid {
        let pid_based = JAB_API_PID_BASED.get_or_init(|| {
            log::info!(
                "Standard JAB search failed, trying PID-based discovery for PID {}",
                pid
            );
            find_jab_dll_for_pid(pid).and_then(|p| load_jab_from_path(&p))
        });
        if pid_based.is_some() {
            return pid_based.as_ref();
        }
    }

    None
}

/// Call Windows_run() once, then never again. Pumps messages on first init.
fn ensure_bridge_running(api: &JabApi) -> bool {
    if JAB_BRIDGE_RUNNING.load(Ordering::Relaxed) {
        return true;
    }

    unsafe {
        let result = (api.windows_run)();
        if result == 0 {
            log::error!("JAB Windows_run() returned false");
            return false;
        }
        pump_messages(1000);
        JAB_BRIDGE_RUNNING.store(true, Ordering::Relaxed);
        log::info!("JAB bridge initialized");
        true
    }
}

/// Pump the Windows message queue so the JAB bridge can discover running JVMs.
unsafe fn pump_messages(ms: u64) {
    let start = std::time::Instant::now();
    let duration = std::time::Duration::from_millis(ms);
    while start.elapsed() < duration {
        let mut msg = MSG::default();
        if PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        } else {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
}

fn wchar_to_string(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

/// Initialize JAB, get root context from HWND, and return (api, vm_id, root_ac).
/// Caller is responsible for releasing root_ac.
fn init_jab_for_hwnd(hwnd: HWND) -> Option<(&'static JabApi, i32, JOBJECT64)> {
    // Get the PID from the window handle so we can try PID-based DLL discovery
    let pid = unsafe {
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid > 0 {
            Some(pid)
        } else {
            None
        }
    };

    let api = get_jab_api(pid)?;
    if !ensure_bridge_running(api) {
        return None;
    }

    unsafe {
        let mut vm_id: i32 = 0;
        let mut ac: JOBJECT64 = 0;

        if (api.get_context_from_hwnd)(hwnd, &mut vm_id, &mut ac) == 0 || ac == 0 {
            // Brief pump in case the VM just started
            pump_messages(200);
            if (api.get_context_from_hwnd)(hwnd, &mut vm_id, &mut ac) == 0 || ac == 0 {
                log::warn!("JAB: getAccessibleContextFromHWND failed");
                return None;
            }
        }

        Some((api, vm_id, ac))
    }
}

/// Navigate from the root context down to a child element via index path.
/// Returns the target context. Caller must release it.
unsafe fn navigate_to_element(
    api: &JabApi,
    vm_id: i32,
    root_ac: JOBJECT64,
    index_path: &[usize],
) -> Result<JOBJECT64, String> {
    let mut current = root_ac;
    // Track intermediate contexts so we can release them (but NOT root_ac — caller owns it)
    let mut intermediates: Vec<JOBJECT64> = Vec::new();

    for (depth, &index) in index_path.iter().enumerate() {
        let child = (api.get_child)(vm_id, current, index as i32);
        if child == 0 {
            // Release intermediates
            for &ac in &intermediates {
                (api.release_object)(vm_id, ac);
            }
            return Err(format!(
                "JAB: getAccessibleChildFromContext failed at depth {} index {}",
                depth, index
            ));
        }
        intermediates.push(child);
        current = child;
    }

    // Release all intermediates EXCEPT the final target
    if let Some(target) = intermediates.pop() {
        for &ac in &intermediates {
            (api.release_object)(vm_id, ac);
        }
        Ok(target)
    } else {
        // Empty path means root was the target — but we can't return root (caller owns it).
        // Return 0 to indicate "use root directly"
        Ok(0)
    }
}

/// Resolve a single child of `parent_ac` by matching the segment's (name, role)
/// with `index_in_parent` as a tiebreaker. Returns the matched child context on
/// success (caller must release it). Returns `None` if no child meets the
/// minimum viable match threshold.
unsafe fn resolve_child_by_string_id(
    api: &JabApi,
    vm_id: i32,
    parent_ac: JOBJECT64,
    seg: &crate::commands::JabElementId,
) -> Option<JOBJECT64> {
    let mut parent_info: AccessibleContextInfo = std::mem::zeroed();
    if (api.get_context_info)(vm_id, parent_ac, &mut parent_info) == 0 {
        return None;
    }
    let child_count = parent_info.children_count.max(0);

    let has_name = seg.name.as_deref().map(|s| !s.is_empty()).unwrap_or(false);
    let has_role = seg.role.as_deref().map(|s| !s.is_empty()).unwrap_or(false);

    // No identifying string data — fall through to index.
    if !has_name && !has_role {
        if (seg.index_in_parent as i32) < child_count {
            let c = (api.get_child)(vm_id, parent_ac, seg.index_in_parent as i32);
            if c != 0 {
                return Some(c);
            }
        }
        return None;
    }

    let mut fetched: Vec<(JOBJECT64, i32)> = Vec::new();

    for i in 0..child_count {
        let child = (api.get_child)(vm_id, parent_ac, i);
        if child == 0 {
            continue;
        }
        let mut info: AccessibleContextInfo = std::mem::zeroed();
        let score = if (api.get_context_info)(vm_id, child, &mut info) != 0 {
            let cname = wchar_to_string(&info.name);
            let crole = wchar_to_string(&info.role_en_us);
            let mut s: i32 = 0;
            if has_name && seg.name.as_deref() == Some(cname.as_str()) {
                s += 100;
            }
            if has_role && seg.role.as_deref() == Some(crole.as_str()) {
                s += 40;
            }
            if i as usize == seg.index_in_parent {
                s += 5;
            }
            s
        } else {
            -1
        };
        fetched.push((child, score));
    }

    // Minimum viable match: a name match if we have a name, otherwise a role match.
    let threshold = if has_name { 100 } else { 40 };

    let mut winner: Option<usize> = None;
    let mut best_score = threshold - 1;
    for (i, &(_ac, score)) in fetched.iter().enumerate() {
        if score > best_score {
            best_score = score;
            winner = Some(i);
        }
    }

    let mut result: Option<JOBJECT64> = None;
    for (i, (ac, _score)) in fetched.into_iter().enumerate() {
        if Some(i) == winner {
            result = Some(ac);
        } else {
            (api.release_object)(vm_id, ac);
        }
    }

    result
}

/// Navigate from root to a target element by matching canonical string IDs at
/// each level. More robust than the index path when sibling indexes shift.
/// Caller must release the returned context (or handle the 0 sentinel).
unsafe fn navigate_to_element_by_string_path(
    api: &JabApi,
    vm_id: i32,
    root_ac: JOBJECT64,
    string_path: &[crate::commands::JabElementId],
) -> Result<JOBJECT64, String> {
    let mut current = root_ac;
    let mut intermediates: Vec<JOBJECT64> = Vec::new();

    for (depth, seg) in string_path.iter().enumerate() {
        let Some(child) = resolve_child_by_string_id(api, vm_id, current, seg) else {
            for &ac in &intermediates {
                (api.release_object)(vm_id, ac);
            }
            return Err(format!(
                "JAB: no child matched string id at depth {} (name={:?} role={:?} index={})",
                depth, seg.name, seg.role, seg.index_in_parent
            ));
        };
        intermediates.push(child);
        current = child;
    }

    if let Some(target) = intermediates.pop() {
        for &ac in &intermediates {
            (api.release_object)(vm_id, ac);
        }
        Ok(target)
    } else {
        Ok(0)
    }
}

/// Prefer the canonical string path; on failure, fall back to the index path.
unsafe fn navigate_preferring_string(
    api: &JabApi,
    vm_id: i32,
    root_ac: JOBJECT64,
    string_path: Option<&[crate::commands::JabElementId]>,
    index_path: &[usize],
) -> Result<JOBJECT64, String> {
    if let Some(sp) = string_path.filter(|sp| !sp.is_empty()) {
        match navigate_to_element_by_string_path(api, vm_id, root_ac, sp) {
            Ok(target) => return Ok(target),
            Err(e) => {
                log::warn!("JAB string path navigation failed ({e}); falling back to index path");
            }
        }
    }
    navigate_to_element(api, vm_id, root_ac, index_path)
}

/// Find the HWND of the first visible top-level window for a given PID.
pub fn find_hwnd_for_pid(target_pid: u32) -> Option<HWND> {
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowExW, GetWindowThreadProcessId, IsWindowVisible,
    };

    unsafe {
        let mut hwnd = FindWindowExW(None, None, None, None).ok()?;
        loop {
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == target_pid && IsWindowVisible(hwnd).as_bool() {
                return Some(hwnd);
            }
            match FindWindowExW(None, Some(hwnd), None, None) {
                Ok(next) => hwnd = next,
                Err(_) => break,
            }
        }
    }

    None
}

// ---------------------------------------------------------------------------
// Dump
// ---------------------------------------------------------------------------

/// Walk a Java window's accessibility tree using the JAB DLL directly.
pub fn gather_jab_dump(hwnd: HWND) -> Option<(String, usize)> {
    let (api, vm_id, ac) = init_jab_for_hwnd(hwnd)?;

    unsafe {
        let mut lines: Vec<String> = Vec::new();
        let mut count: usize = 0;

        dump_jab_element(api, vm_id, ac, 0, &mut lines, &mut count);
        (api.release_object)(vm_id, ac);

        if lines.is_empty() {
            None
        } else {
            Some((lines.join("\n"), count))
        }
    }
}

unsafe fn dump_jab_element(
    api: &JabApi,
    vm_id: i32,
    ac: JOBJECT64,
    depth: usize,
    lines: &mut Vec<String>,
    count: &mut usize,
) {
    if depth > MAX_JAB_DEPTH || *count >= MAX_JAB_ELEMENTS {
        return;
    }

    let mut info: AccessibleContextInfo = std::mem::zeroed();
    if (api.get_context_info)(vm_id, ac, &mut info) == 0 {
        return;
    }

    *count += 1;

    let name = wchar_to_string(&info.name);
    let description = wchar_to_string(&info.description);
    let role = wchar_to_string(&info.role_en_us);
    let states = wchar_to_string(&info.states_en_us);

    let indent = "  ".repeat(depth);
    let role_display = if role.is_empty() { "unknown" } else { &role };
    let mut line = format!("{}[{}] \"{}\"", indent, role_display, name);

    if !description.is_empty() {
        let d = if description.len() > 100 {
            format!("{}...", &description[..100])
        } else {
            description
        };
        line.push_str(&format!(" desc=\"{}\"", d));
    }

    if info.accessible_text != 0 {
        extract_text_append(api, vm_id, ac, &mut line);
    }

    let mut annotations: Vec<String> = Vec::new();
    if info.accessible_text != 0 {
        annotations.push("editable".to_string());
    }
    if info.accessible_action != 0 {
        annotations.push("action".to_string());
    }
    if !states.is_empty() {
        annotations.push(format!("states={}", states));
    }

    if !annotations.is_empty() {
        line.push_str(&format!(" ({})", annotations.join(", ")));
    }

    lines.push(line);

    for i in 0..info.children_count {
        if *count >= MAX_JAB_ELEMENTS {
            break;
        }
        let child = (api.get_child)(vm_id, ac, i);
        if child != 0 {
            dump_jab_element(api, vm_id, child, depth + 1, lines, count);
            (api.release_object)(vm_id, child);
        }
    }
}

unsafe fn extract_text_append(api: &JabApi, vm_id: i32, ac: JOBJECT64, line: &mut String) {
    let mut text_info: AccessibleTextInfo = std::mem::zeroed();
    if (api.get_text_info)(vm_id, ac, &mut text_info, 0, 0) != 0 && text_info.char_count > 0 {
        let len = text_info.char_count.min(200);
        let mut buf = vec![0u16; (len + 1) as usize];
        if (api.get_text_range)(vm_id, ac, 0, len - 1, buf.as_mut_ptr(), buf.len() as i16) != 0 {
            let text = wchar_to_string(&buf);
            if !text.is_empty() {
                let display = if text.len() > 100 {
                    format!("{}...", &text[..100])
                } else {
                    text
                };
                line.push_str(&format!(" text=\"{}\"", display));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Get focused field info (for registration)
// ---------------------------------------------------------------------------

/// Get accessibility info for the currently focused JAB element.
/// Builds an index path by walking up from the focused element to the root.
pub fn jab_get_focused_field_info(
    hwnd: HWND,
    app_pid: i32,
    app_name: Option<&str>,
    window_title: Option<String>,
) -> Option<crate::commands::AccessibilityFieldInfo> {
    let api = get_jab_api(Some(app_pid as u32))?;
    if !ensure_bridge_running(api) {
        return None;
    }

    unsafe {
        // Get focused element context
        let mut vm_id: i32 = 0;
        let mut focused_ac: JOBJECT64 = 0;

        if (api.get_context_with_focus)(hwnd, &mut vm_id, &mut focused_ac) == 0 || focused_ac == 0 {
            pump_messages(200);
            if (api.get_context_with_focus)(hwnd, &mut vm_id, &mut focused_ac) == 0
                || focused_ac == 0
            {
                log::warn!("JAB: getAccessibleContextWithFocus failed");
                return None;
            }
        }

        let mut info: AccessibleContextInfo = std::mem::zeroed();
        if (api.get_context_info)(vm_id, focused_ac, &mut info) == 0 {
            (api.release_object)(vm_id, focused_ac);
            return None;
        }

        let name = wchar_to_string(&info.name);
        let role = wchar_to_string(&info.role_en_us);
        let states = wchar_to_string(&info.states_en_us);
        let description = wchar_to_string(&info.description);

        let is_editable = states.contains("editable");

        // Get current text value
        let mut value: Option<String> = None;
        if info.accessible_text != 0 {
            let mut text_info: AccessibleTextInfo = std::mem::zeroed();
            if (api.get_text_info)(vm_id, focused_ac, &mut text_info, 0, 0) != 0
                && text_info.char_count > 0
            {
                let len = text_info.char_count.min(500);
                let mut buf = vec![0u16; (len + 1) as usize];
                if (api.get_text_range)(
                    vm_id,
                    focused_ac,
                    0,
                    len - 1,
                    buf.as_mut_ptr(),
                    buf.len() as i16,
                ) != 0
                {
                    let text = wchar_to_string(&buf);
                    if !text.is_empty() {
                        value = Some(text);
                    }
                }
            }
        }

        // Walk up from focused element to build index path and canonical string path
        let mut index_path: Vec<usize> = Vec::new();
        let mut string_path: Vec<crate::commands::JabElementId> = Vec::new();
        let mut to_release: Vec<JOBJECT64> = Vec::new();
        let mut current = focused_ac;

        loop {
            let mut current_info: AccessibleContextInfo = std::mem::zeroed();
            if (api.get_context_info)(vm_id, current, &mut current_info) == 0 {
                break;
            }

            let parent = (api.get_parent)(vm_id, current);
            if parent == 0 {
                break; // reached root
            }

            let resolved_idx: Option<usize> = if current_info.index_in_parent >= 0 {
                Some(current_info.index_in_parent as usize)
            } else {
                // index_in_parent is -1, try to find by iteration
                let mut parent_info: AccessibleContextInfo = std::mem::zeroed();
                let mut found: Option<usize> = None;
                if (api.get_context_info)(vm_id, parent, &mut parent_info) != 0 {
                    for i in 0..parent_info.children_count {
                        let sibling = (api.get_child)(vm_id, parent, i);
                        if sibling == current {
                            found = Some(i as usize);
                            break;
                        }
                        if sibling != 0 {
                            (api.release_object)(vm_id, sibling);
                        }
                    }
                }
                found
            };

            let Some(idx) = resolved_idx else {
                (api.release_object)(vm_id, parent);
                break;
            };

            let level_name = wchar_to_string(&current_info.name);
            let level_role = wchar_to_string(&current_info.role_en_us);
            index_path.push(idx);
            string_path.push(crate::commands::JabElementId {
                name: if level_name.is_empty() {
                    None
                } else {
                    Some(level_name)
                },
                role: if level_role.is_empty() {
                    None
                } else {
                    Some(level_role)
                },
                index_in_parent: idx,
            });

            to_release.push(parent);
            current = parent;
        }

        index_path.reverse();
        string_path.reverse();

        // Cleanup
        for ac in to_release {
            (api.release_object)(vm_id, ac);
        }
        (api.release_object)(vm_id, focused_ac);

        Some(crate::commands::AccessibilityFieldInfo {
            role: Some(role),
            title: if name.is_empty() { None } else { Some(name) },
            description: if description.is_empty() {
                None
            } else {
                Some(description)
            },
            value,
            placeholder: None,
            app_pid: Some(app_pid),
            app_name: app_name.map(|s| s.to_string()),
            window_title,
            is_settable: is_editable,
            element_index_path: index_path,
            fingerprint_chain: vec![],
            can_paste: false,
            backend: Some("jab".to_string()),
            jab_string_path: string_path,
            app_identity: None,
            details: None,
        })
    }
}

// ---------------------------------------------------------------------------
// Write text
// ---------------------------------------------------------------------------

/// Write text to a JAB element. Prefers the canonical string path when provided;
/// falls back to the numeric index path otherwise.
pub fn jab_write_text(
    hwnd: HWND,
    string_path: Option<&[crate::commands::JabElementId]>,
    index_path: &[usize],
    text: &str,
) -> Result<(), String> {
    let (api, vm_id, root_ac) =
        init_jab_for_hwnd(hwnd).ok_or_else(|| "JAB bridge not available".to_string())?;

    unsafe {
        let target = navigate_preferring_string(api, vm_id, root_ac, string_path, index_path)?;
        let ac_to_write = if target == 0 { root_ac } else { target };

        // Convert text to null-terminated UTF-16
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let result = (api.set_text_contents)(vm_id, ac_to_write, wide.as_ptr());

        if target != 0 {
            (api.release_object)(vm_id, target);
        }
        (api.release_object)(vm_id, root_ac);

        if result == 0 {
            Err("JAB: setTextContents failed (element may not be editable)".to_string())
        } else {
            Ok(())
        }
    }
}

// ---------------------------------------------------------------------------
// Focus element
// ---------------------------------------------------------------------------

/// Focus a JAB element. Prefers the canonical string path when provided;
/// falls back to the numeric index path otherwise.
pub fn jab_focus_element(
    hwnd: HWND,
    string_path: Option<&[crate::commands::JabElementId]>,
    index_path: &[usize],
) -> Result<(), String> {
    let (api, vm_id, root_ac) =
        init_jab_for_hwnd(hwnd).ok_or_else(|| "JAB bridge not available".to_string())?;

    unsafe {
        let target = navigate_preferring_string(api, vm_id, root_ac, string_path, index_path)?;
        let ac_to_focus = if target == 0 { root_ac } else { target };

        let result = (api.request_focus)(vm_id, ac_to_focus);

        // Place caret at a random position within the text
        if result != 0 {
            let mut text_info: AccessibleTextInfo = std::mem::zeroed();
            if (api.get_text_info)(vm_id, ac_to_focus, &mut text_info, 0, 0) != 0
                && text_info.char_count > 0
            {
                let position = (std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .subsec_nanos() as i32)
                    % (text_info.char_count + 1);
                (api.set_caret_position)(vm_id, ac_to_focus, position);
            }
        }

        if target != 0 {
            (api.release_object)(vm_id, target);
        }
        (api.release_object)(vm_id, root_ac);

        if result == 0 {
            Err("JAB: requestFocus failed".to_string())
        } else {
            Ok(())
        }
    }
}

// ---------------------------------------------------------------------------
// Caret positioning
// ---------------------------------------------------------------------------

/// Set the caret (cursor) position within a JAB text element. Prefers the
/// canonical string path when provided; falls back to the numeric index path.
pub fn jab_set_caret_position(
    hwnd: HWND,
    string_path: Option<&[crate::commands::JabElementId]>,
    index_path: &[usize],
    position: usize,
) -> Result<(), String> {
    let (api, vm_id, root_ac) =
        init_jab_for_hwnd(hwnd).ok_or_else(|| "JAB bridge not available".to_string())?;

    unsafe {
        let target = navigate_preferring_string(api, vm_id, root_ac, string_path, index_path)?;
        let ac = if target == 0 { root_ac } else { target };

        let result = (api.set_caret_position)(vm_id, ac, position as i32);

        if target != 0 {
            (api.release_object)(vm_id, target);
        }
        (api.release_object)(vm_id, root_ac);

        if result == 0 {
            Err("JAB: setCaretPosition failed".to_string())
        } else {
            Ok(())
        }
    }
}

// ---------------------------------------------------------------------------
// Read text value
// ---------------------------------------------------------------------------

/// Read the current text value of a JAB element. Prefers the canonical string
/// path when provided; falls back to the numeric index path otherwise.
pub fn jab_read_text(
    hwnd: HWND,
    string_path: Option<&[crate::commands::JabElementId]>,
    index_path: &[usize],
) -> Result<Option<String>, String> {
    let (api, vm_id, root_ac) =
        init_jab_for_hwnd(hwnd).ok_or_else(|| "JAB bridge not available".to_string())?;

    unsafe {
        let target = navigate_preferring_string(api, vm_id, root_ac, string_path, index_path)?;
        let ac = if target == 0 { root_ac } else { target };

        let mut info: AccessibleContextInfo = std::mem::zeroed();
        let has_info = (api.get_context_info)(vm_id, ac, &mut info) != 0;

        let value = if has_info && info.accessible_text != 0 {
            let mut text_info: AccessibleTextInfo = std::mem::zeroed();
            if (api.get_text_info)(vm_id, ac, &mut text_info, 0, 0) != 0 && text_info.char_count > 0
            {
                let len = text_info.char_count.min(2000);
                let mut buf = vec![0u16; (len + 1) as usize];
                if (api.get_text_range)(vm_id, ac, 0, len - 1, buf.as_mut_ptr(), buf.len() as i16)
                    != 0
                {
                    let text = wchar_to_string(&buf);
                    if text.is_empty() {
                        None
                    } else {
                        Some(text)
                    }
                } else {
                    None
                }
            } else {
                Some(String::new())
            }
        } else {
            // Try name as fallback
            let name = wchar_to_string(&info.name);
            if name.is_empty() {
                None
            } else {
                Some(name)
            }
        };

        if target != 0 {
            (api.release_object)(vm_id, target);
        }
        (api.release_object)(vm_id, root_ac);

        Ok(value)
    }
}
