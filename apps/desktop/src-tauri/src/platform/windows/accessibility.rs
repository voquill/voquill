use crate::commands::{
    AccessibilityDumpResult, FieldValueRequest, FieldValueResult, ScreenContextInfo, TextFieldInfo,
};
use std::cell::RefCell;
use std::collections::HashSet;
use std::sync::OnceLock;
use windows::core::{Interface, BSTR};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern,
    IUIAutomationTreeWalker, IUIAutomationValuePattern, TreeScope_Children,
    UIA_AppBarControlTypeId, UIA_AutomationIdPropertyId, UIA_ButtonControlTypeId,
    UIA_CalendarControlTypeId, UIA_CheckBoxControlTypeId, UIA_ClassNamePropertyId,
    UIA_ComboBoxControlTypeId, UIA_ControlTypePropertyId, UIA_CustomControlTypeId,
    UIA_DataGridControlTypeId, UIA_DataItemControlTypeId, UIA_DocumentControlTypeId,
    UIA_EditControlTypeId, UIA_FrameworkIdPropertyId, UIA_GroupControlTypeId,
    UIA_HeaderControlTypeId, UIA_HeaderItemControlTypeId, UIA_HelpTextPropertyId,
    UIA_HyperlinkControlTypeId, UIA_ImageControlTypeId, UIA_ListControlTypeId,
    UIA_ListItemControlTypeId, UIA_MenuBarControlTypeId, UIA_MenuControlTypeId,
    UIA_MenuItemControlTypeId, UIA_NamePropertyId, UIA_PaneControlTypeId,
    UIA_ProgressBarControlTypeId, UIA_RadioButtonControlTypeId, UIA_SemanticZoomControlTypeId,
    UIA_SliderControlTypeId, UIA_SpinnerControlTypeId, UIA_SplitButtonControlTypeId,
    UIA_StatusBarControlTypeId, UIA_TabControlTypeId, UIA_TabItemControlTypeId,
    UIA_TableControlTypeId, UIA_TextControlTypeId, UIA_TextPatternId, UIA_ThumbControlTypeId,
    UIA_TitleBarControlTypeId, UIA_ToolBarControlTypeId, UIA_TreeControlTypeId,
    UIA_TreeItemControlTypeId, UIA_ValuePatternId, UIA_WindowControlTypeId,
};

// ---------------------------------------------------------------------------
// Dedicated STA thread for all UIA work.
//
// UIAutomation performs best from a Single-Threaded Apartment (STA).  Running
// from MTA (as tokio's blocking threads do) forces COM to marshal every call
// across apartments, which adds massive latency — especially on slower
// machines.  A single dedicated STA thread with a cached IUIAutomation
// instance eliminates both the marshaling overhead and the repeated
// CoCreateInstance cost.
// ---------------------------------------------------------------------------

struct UiaThread {
    sender: std::sync::mpsc::Sender<Box<dyn FnOnce() + Send>>,
}

static UIA_THREAD: OnceLock<UiaThread> = OnceLock::new();

fn get_uia_thread() -> &'static UiaThread {
    UIA_THREAD.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<Box<dyn FnOnce() + Send>>();

        std::thread::Builder::new()
            .name("uia-sta".into())
            .spawn(move || {
                unsafe {
                    let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                }
                for task in rx {
                    task();
                }
                unsafe {
                    CoUninitialize();
                }
            })
            .expect("failed to spawn UIA STA thread");

        UiaThread { sender: tx }
    })
}

/// Run a closure on the dedicated UIA STA thread and block until it returns.
fn run_on_uia_thread<F, R>(f: F) -> R
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    get_uia_thread()
        .sender
        .send(Box::new(move || {
            let _ = tx.send(f());
        }))
        .expect("UIA thread channel closed");
    rx.recv().expect("UIA thread dropped result")
}

// Cached IUIAutomation instance, created once on the STA thread.
thread_local! {
    static CACHED_AUTOMATION: RefCell<Option<IUIAutomation>> = const { RefCell::new(None) };
}

fn with_automation<F, R>(f: F) -> Result<R, windows::core::Error>
where
    F: FnOnce(&IUIAutomation) -> Result<R, windows::core::Error>,
{
    CACHED_AUTOMATION.with(|cell| {
        let mut opt = cell.borrow_mut();
        if opt.is_none() {
            unsafe {
                *opt = Some(CoCreateInstance(
                    &CUIAutomation,
                    None,
                    CLSCTX_INPROC_SERVER,
                )?);
            }
            log::info!("Cached IUIAutomation instance on STA thread");
        }
        f(opt.as_ref().unwrap())
    })
}

fn empty_text_field_info() -> TextFieldInfo {
    TextFieldInfo {
        cursor_position: None,
        selection_length: None,
        text_content: None,
    }
}

pub fn get_text_field_info() -> TextFieldInfo {
    run_on_uia_thread(|| match try_get_text_field_info() {
        Ok(info) => info,
        Err(e) => {
            log::error!("Error getting text field info: {:?}", e);
            empty_text_field_info()
        }
    })
}

pub fn is_text_input_focused() -> bool {
    run_on_uia_thread(|| try_is_text_input_focused().unwrap_or(false))
}

fn try_get_text_field_info() -> Result<TextFieldInfo, windows::core::Error> {
    with_automation(|automation| unsafe {
        let focused = automation.GetFocusedElement()?;

        let pattern = focused.GetCurrentPattern(UIA_TextPatternId)?;

        if pattern.as_raw().is_null() {
            log::debug!("Focused element does not support TextPattern");
            return Ok(empty_text_field_info());
        }

        let text_pattern: IUIAutomationTextPattern = pattern.cast()?;

        let document_range = text_pattern.DocumentRange()?;
        let text_bstr: BSTR = document_range.GetText(-1)?;
        let text_content = Some(text_bstr.to_string());

        let selections = text_pattern.GetSelection()?;
        let selection_count = selections.Length()?;

        let (cursor_position, selection_length) = if selection_count > 0 {
            let selection = selections.GetElement(0)?;

            let selection_text: BSTR = selection.GetText(-1)?;
            let sel_len = selection_text.to_string().len();

            let doc_start = document_range.Clone()?;

            doc_start.MoveEndpointByRange(
                windows::Win32::UI::Accessibility::TextPatternRangeEndpoint_End,
                &selection,
                windows::Win32::UI::Accessibility::TextPatternRangeEndpoint_Start,
            )?;

            let cursor_text: BSTR = doc_start.GetText(-1)?;
            let cursor_pos = cursor_text.to_string().len();

            (Some(cursor_pos), Some(sel_len))
        } else {
            (None, Some(0))
        };

        Ok(TextFieldInfo {
            cursor_position,
            selection_length,
            text_content,
        })
    })
}

fn try_is_text_input_focused() -> Result<bool, windows::core::Error> {
    with_automation(|automation| unsafe {
        let focused = automation.GetFocusedElement()?;
        let control_type = get_control_type(&focused);

        // Rather than trying to prove a control IS a text input (which
        // is unreliable — many editors use MSAA, custom frameworks, or
        // web renderers that don't expose UIA patterns), reject control
        // types that are definitively NOT text inputs. Everything else
        // (Edit, Document, Custom, Pane, ComboBox, etc.) is assumed to
        // potentially accept text.
        Ok(!is_non_text_control(control_type))
    })
}

fn is_non_text_control(control_type: i32) -> bool {
    // Keep this list narrow. Electron/custom/terminal surfaces (Terminus etc.)
    // often report focus as Window/Pane/List/ListItem/Document/Custom even
    // when a text input is active, so anything ambiguous is treated as
    // potentially editable and paste falls through to a real keystroke.
    [
        UIA_ButtonControlTypeId.0,
        UIA_CheckBoxControlTypeId.0,
        UIA_MenuItemControlTypeId.0,
        UIA_ProgressBarControlTypeId.0,
        UIA_RadioButtonControlTypeId.0,
        UIA_SliderControlTypeId.0,
        UIA_SplitButtonControlTypeId.0,
        UIA_ThumbControlTypeId.0,
        UIA_TitleBarControlTypeId.0,
    ]
    .contains(&control_type)
}

pub fn get_screen_context() -> ScreenContextInfo {
    run_on_uia_thread(|| match try_get_screen_context() {
        Ok(info) => info,
        Err(e) => {
            log::error!("Error getting screen context: {:?}", e);
            ScreenContextInfo {
                screen_context: None,
            }
        }
    })
}

// --- gather_accessibility_dump ---

const DUMP_MAX_DEPTH: usize = 30;
const DUMP_MAX_ELEMENTS: usize = 5000;

pub fn gather_accessibility_dump() -> AccessibilityDumpResult {
    run_on_uia_thread(|| match try_gather_accessibility_dump() {
        Ok(result) => result,
        Err(e) => {
            log::error!("Error gathering accessibility dump: {:?}", e);
            AccessibilityDumpResult {
                dump: None,
                window_title: None,
                process_name: None,
                element_count: 0,
            }
        }
    })
}

fn try_gather_accessibility_dump() -> Result<AccessibilityDumpResult, windows::core::Error> {
    with_automation(|automation| unsafe {
        // Get the foreground window
        let hwnd = windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow();
        if hwnd.0.is_null() {
            return Ok(AccessibilityDumpResult {
                dump: None,
                window_title: None,
                process_name: None,
                element_count: 0,
            });
        }

        // Get the process ID of the foreground window
        let mut pid: u32 = 0;
        windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let process_name = if pid > 0 { get_process_name(pid) } else { None };

        // Detect Java process by executable name (JAB may report framework as Win32)
        let mut is_java_app = is_java_process_name(process_name.as_deref());

        // Get the UIAutomation element for the foreground window
        let window_element = automation.ElementFromHandle(hwnd)?;
        let window_title = get_element_name(&window_element);

        let mut lines: Vec<String> = Vec::new();
        let mut element_count: usize = 0;

        // Build window header line
        let mut header = format!("[Window] \"{}\"", window_title.as_deref().unwrap_or(""));
        if pid > 0 {
            header.push_str(&format!(" (pid={})", pid));
        }
        if let Some(ref name) = process_name {
            header.push_str(&format!(" process={}", name));
        }
        let framework = get_string_property(&window_element, UIA_FrameworkIdPropertyId);
        if let Some(ref fw) = framework {
            header.push_str(&format!(" framework={}", fw));
            if fw == "Java" || fw == "JavaFX" {
                is_java_app = true;
            }
        }
        lines.push(header);
        element_count += 1;

        // Recursively dump the full tree
        dump_children(
            automation,
            &window_element,
            1,
            &mut lines,
            &mut element_count,
            &mut is_java_app,
        )?;

        // Java app with few UIA elements: fall back to direct JAB DLL interop
        if is_java_app && element_count < 10 {
            log::info!(
                "Java process detected with only {} UIA elements, trying direct JAB API",
                element_count
            );
            if let Some((jab_dump, jab_count)) = super::jab::gather_jab_dump(hwnd) {
                return Ok(AccessibilityDumpResult {
                    dump: Some(format!(
                        "{}\n{}",
                        lines.first().cloned().unwrap_or_default(),
                        jab_dump
                    )),
                    window_title,
                    process_name,
                    element_count: jab_count + 1, // +1 for the window header
                });
            }

            // JAB fallback failed too
            lines.push(String::new());
            lines.push(
                "WARNING: This appears to be a Java application but the accessibility tree \
                 is not visible. Ensure Java Access Bridge is enabled and the \
                 .accessibility.properties file is configured."
                    .to_string(),
            );
        }

        let dump = if lines.is_empty() {
            None
        } else {
            Some(lines.join("\n"))
        };

        Ok(AccessibilityDumpResult {
            dump,
            window_title,
            process_name,
            element_count,
        })
    })
}

unsafe fn dump_children(
    automation: &IUIAutomation,
    parent: &IUIAutomationElement,
    depth: usize,
    lines: &mut Vec<String>,
    element_count: &mut usize,
    is_java_app: &mut bool,
) -> Result<(), windows::core::Error> {
    if depth > DUMP_MAX_DEPTH || *element_count >= DUMP_MAX_ELEMENTS {
        return Ok(());
    }

    let true_condition = automation.CreateTrueCondition()?;
    let children = match parent.FindAll(TreeScope_Children, &true_condition) {
        Ok(c) => c,
        Err(_) => return Ok(()),
    };

    let count = children.Length().unwrap_or(0);
    for i in 0..count {
        if *element_count >= DUMP_MAX_ELEMENTS {
            lines.push(format!(
                "{}... (truncated, max {} elements reached)",
                "  ".repeat(depth),
                DUMP_MAX_ELEMENTS
            ));
            break;
        }

        if let Ok(child) = children.GetElement(i) {
            let line = format_dump_element(&child, depth, is_java_app);
            lines.push(line);
            *element_count += 1;

            dump_children(
                automation,
                &child,
                depth + 1,
                lines,
                element_count,
                is_java_app,
            )?;
        }
    }

    Ok(())
}

unsafe fn format_dump_element(
    element: &IUIAutomationElement,
    depth: usize,
    is_java_app: &mut bool,
) -> String {
    let indent = "  ".repeat(depth);
    let control_type = get_control_type(element);
    let type_name = control_type_name(control_type);
    let name = get_element_name(element);
    let value = get_element_value(element);
    let automation_id = get_string_property(element, UIA_AutomationIdPropertyId);
    let class_name = get_string_property(element, UIA_ClassNamePropertyId);
    let framework_id = get_string_property(element, UIA_FrameworkIdPropertyId);
    let help_text = get_element_help_text(element);

    if let Some(ref fw) = framework_id {
        if fw == "Java" || fw == "JavaFX" {
            *is_java_app = true;
        }
    }

    // Check settable (writable via ValuePattern)
    let is_settable = element
        .GetCurrentPattern(UIA_ValuePatternId)
        .ok()
        .filter(|p| !p.as_raw().is_null())
        .and_then(|p| p.cast::<IUIAutomationValuePattern>().ok())
        .and_then(|vp| vp.CurrentIsReadOnly().ok())
        .map(|ro| !ro.as_bool())
        .unwrap_or(false);

    let has_text_pattern = element
        .GetCurrentPattern(UIA_TextPatternId)
        .map(|p| !p.as_raw().is_null())
        .unwrap_or(false);

    // Build the line: [Type] "Name"
    let display_name = name.as_deref().unwrap_or("");
    let mut line = format!("{}[{}] \"{}\"", indent, type_name, display_name);

    // Append value (truncated if long)
    if let Some(ref v) = value {
        let v = v.trim();
        if !v.is_empty() {
            let display = if v.len() > 100 {
                format!("{}...", &v[..100])
            } else {
                v.to_string()
            };
            line.push_str(&format!(" value=\"{}\"", display));
        }
    }

    // Collect annotation tokens
    let mut annotations: Vec<String> = Vec::new();
    if is_settable {
        annotations.push("settable".to_string());
    }
    if has_text_pattern {
        annotations.push("text-pattern".to_string());
    }
    if let Some(ref id) = automation_id {
        if !id.is_empty() {
            annotations.push(format!("id={}", id));
        }
    }
    if let Some(ref cls) = class_name {
        if !cls.is_empty() {
            annotations.push(format!("class={}", cls));
        }
    }
    if let Some(ref fw) = framework_id {
        if !fw.is_empty() {
            annotations.push(format!("framework={}", fw));
        }
    }
    if let Some(ref ht) = help_text {
        let ht = ht.trim();
        if !ht.is_empty() && ht.len() < 200 {
            annotations.push(format!("help=\"{}\"", ht));
        }
    }

    if !annotations.is_empty() {
        line.push_str(&format!(" ({})", annotations.join(", ")));
    }

    line
}

// --- get_screen_context ---

const MAX_CONTEXT_LENGTH: usize = 12000;
const MAX_LEVELS_UP: usize = 20;
const MAX_SIBLINGS: i32 = 80;
const MAX_RECURSION_DEPTH: usize = 8;

fn try_get_screen_context() -> Result<ScreenContextInfo, windows::core::Error> {
    with_automation(|automation| unsafe {
        let focused = automation.GetFocusedElement()?;
        let tree_walker = automation.ControlViewWalker()?;

        let context = gather_context_outward(automation, &tree_walker, &focused)?;
        let screen_context = if context.is_empty() {
            None
        } else {
            Some(context)
        };

        Ok(ScreenContextInfo { screen_context })
    })
}

unsafe fn gather_context_outward(
    automation: &IUIAutomation,
    tree_walker: &IUIAutomationTreeWalker,
    focused_element: &IUIAutomationElement,
) -> Result<String, windows::core::Error> {
    let mut texts: Vec<String> = Vec::new();

    let focused_control_type = get_control_type(focused_element);
    let focused_texts = extract_text_from_element(focused_element, focused_control_type)?;
    texts.extend(focused_texts);

    let mut current_element = focused_element.clone();
    let mut levels_up = 0;

    while levels_up < MAX_LEVELS_UP {
        let parent = match tree_walker.GetParentElement(&current_element) {
            Ok(p) => p,
            Err(_) => break,
        };

        let control_type = get_control_type(&parent);

        if control_type == UIA_WindowControlTypeId.0 {
            if let Some(name) = get_element_name(&parent) {
                let t = name.trim();
                if !t.is_empty() {
                    texts.push(format!("[Window: {}]", t));
                }
            }
            break;
        }

        if let Some(name) = get_element_name(&parent) {
            let t = name.trim();
            if !t.is_empty() && t.len() > 1 {
                texts.push(t.to_string());
            }
        }

        if let Ok(children) = parent.FindAll(TreeScope_Children, &automation.CreateTrueCondition()?)
        {
            let count = children.Length()?.min(MAX_SIBLINGS);
            for i in 0..count {
                if let Ok(sibling) = children.GetElement(i) {
                    let sibling_texts =
                        extract_text_recursive(automation, &sibling, 0, MAX_RECURSION_DEPTH)?;
                    texts.extend(sibling_texts);

                    let current_len: usize = texts.iter().map(|s| s.len()).sum();
                    if current_len > MAX_CONTEXT_LENGTH {
                        break;
                    }
                }
            }
        }

        let current_len: usize = texts.iter().map(|s| s.len()).sum();
        if current_len > MAX_CONTEXT_LENGTH {
            break;
        }

        current_element = parent;
        levels_up += 1;
    }

    let mut seen = HashSet::new();
    let unique_texts: Vec<String> = texts
        .into_iter()
        .filter(|s| seen.insert(s.clone()))
        .collect();

    Ok(unique_texts.join("\n"))
}

unsafe fn extract_text_recursive(
    automation: &IUIAutomation,
    element: &IUIAutomationElement,
    depth: usize,
    max_depth: usize,
) -> Result<Vec<String>, windows::core::Error> {
    if depth > max_depth {
        return Ok(Vec::new());
    }

    let mut texts = Vec::new();
    let control_type = get_control_type(element);

    if should_skip_control_type(control_type) {
        return Ok(texts);
    }

    let element_texts = extract_text_from_element(element, control_type)?;
    texts.extend(element_texts);

    if is_container_control_type(control_type) {
        if let Ok(children) =
            element.FindAll(TreeScope_Children, &automation.CreateTrueCondition()?)
        {
            let count = children.Length()?.min(30);
            for i in 0..count {
                if let Ok(child) = children.GetElement(i) {
                    let child_texts =
                        extract_text_recursive(automation, &child, depth + 1, max_depth)?;
                    texts.extend(child_texts);
                }
            }
        }
    }

    Ok(texts)
}

unsafe fn extract_text_from_element(
    element: &IUIAutomationElement,
    control_type: i32,
) -> Result<Vec<String>, windows::core::Error> {
    let mut texts = Vec::new();

    if let Some(name) = get_element_name(element) {
        let t = name.trim();
        if !t.is_empty() && t.len() < 500 {
            texts.push(t.to_string());
        }
    }

    let value_safe_types = [
        UIA_TextControlTypeId.0,
        UIA_HyperlinkControlTypeId.0,
        UIA_DataItemControlTypeId.0,
        UIA_ListItemControlTypeId.0,
        UIA_TreeItemControlTypeId.0,
        UIA_MenuItemControlTypeId.0,
        UIA_ButtonControlTypeId.0,
        UIA_CheckBoxControlTypeId.0,
        UIA_RadioButtonControlTypeId.0,
        UIA_ComboBoxControlTypeId.0,
        UIA_TabItemControlTypeId.0,
        UIA_HeaderItemControlTypeId.0,
        UIA_SplitButtonControlTypeId.0,
        UIA_SliderControlTypeId.0,
        UIA_SpinnerControlTypeId.0,
        UIA_ProgressBarControlTypeId.0,
    ];

    if value_safe_types.contains(&control_type) {
        if let Some(value) = get_element_value(element) {
            let t = value.trim();
            if !t.is_empty() && t.len() < 500 && !texts.contains(&t.to_string()) {
                texts.push(t.to_string());
            }
        }
    }

    if let Some(help_text) = get_element_help_text(element) {
        let t = help_text.trim();
        if !t.is_empty() && t.len() < 500 && !texts.contains(&t.to_string()) {
            texts.push(t.to_string());
        }
    }

    Ok(texts)
}

fn get_control_type(element: &IUIAutomationElement) -> i32 {
    unsafe {
        element
            .GetCurrentPropertyValue(UIA_ControlTypePropertyId)
            .ok()
            .map(|v| v.Anonymous.Anonymous.Anonymous.lVal)
            .unwrap_or(0)
    }
}

fn get_element_name(element: &IUIAutomationElement) -> Option<String> {
    unsafe {
        element
            .GetCurrentPropertyValue(UIA_NamePropertyId)
            .ok()
            .and_then(|v| {
                let bstr_ref = &v.Anonymous.Anonymous.Anonymous.bstrVal;
                let s = bstr_ref.to_string();
                if s.is_empty() {
                    None
                } else {
                    Some(s)
                }
            })
    }
}

fn get_element_value(element: &IUIAutomationElement) -> Option<String> {
    unsafe {
        let pattern = element.GetCurrentPattern(UIA_ValuePatternId).ok()?;
        if pattern.as_raw().is_null() {
            return None;
        }
        let value_pattern: IUIAutomationValuePattern = pattern.cast().ok()?;
        let value: BSTR = value_pattern.CurrentValue().ok()?;
        let s = value.to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }
}

fn get_element_help_text(element: &IUIAutomationElement) -> Option<String> {
    unsafe {
        element
            .GetCurrentPropertyValue(UIA_HelpTextPropertyId)
            .ok()
            .and_then(|v| {
                let bstr_ref = &v.Anonymous.Anonymous.Anonymous.bstrVal;
                let s = bstr_ref.to_string();
                if s.is_empty() {
                    None
                } else {
                    Some(s)
                }
            })
    }
}

fn get_string_property(
    element: &IUIAutomationElement,
    property_id: windows::Win32::UI::Accessibility::UIA_PROPERTY_ID,
) -> Option<String> {
    unsafe {
        element
            .GetCurrentPropertyValue(property_id)
            .ok()
            .and_then(|v| {
                let bstr_ref = &v.Anonymous.Anonymous.Anonymous.bstrVal;
                let s = bstr_ref.to_string();
                if s.is_empty() {
                    None
                } else {
                    Some(s)
                }
            })
    }
}

fn build_element_fingerprint(
    element: &IUIAutomationElement,
    child_index: usize,
) -> crate::commands::ElementFingerprint {
    let automation_id = get_string_property(element, UIA_AutomationIdPropertyId);
    let class_name = get_string_property(element, UIA_ClassNamePropertyId);
    let control_type = get_control_type(element);
    let name = get_element_name(element);
    let framework_id = get_string_property(element, UIA_FrameworkIdPropertyId);

    crate::commands::ElementFingerprint {
        automation_id,
        class_name,
        control_type,
        name,
        framework_id,
        child_index,
        ax_role: None,
        ax_subrole: None,
        ax_title: None,
        ax_description: None,
        ax_identifier: None,
        details: None,
    }
}

unsafe fn find_app_window(
    automation: &IUIAutomation,
    app_pid: i32,
) -> Result<IUIAutomationElement, String> {
    let root = automation
        .GetRootElement()
        .map_err(|e| format!("Failed to get root element: {e}"))?;

    let true_condition = automation
        .CreateTrueCondition()
        .map_err(|e| format!("Failed to create condition: {e}"))?;

    let top_level_windows = root
        .FindAll(TreeScope_Children, &true_condition)
        .map_err(|e| format!("Failed to enumerate windows: {e}"))?;

    let count = top_level_windows
        .Length()
        .map_err(|e| format!("Failed to get window count: {e}"))?;

    for i in 0..count {
        if let Ok(win) = top_level_windows.GetElement(i) {
            let pid_variant = win.GetCurrentPropertyValue(
                windows::Win32::UI::Accessibility::UIA_ProcessIdPropertyId,
            );
            if let Ok(pv) = pid_variant {
                let win_pid = unsafe { pv.Anonymous.Anonymous.Anonymous.lVal };
                if win_pid == app_pid {
                    return Ok(win);
                }
            }
        }
    }

    Err(format!("No window found for PID {app_pid}"))
}

unsafe fn bring_window_to_foreground(window: &IUIAutomationElement) -> Result<(), String> {
    let hwnd_variant = window
        .GetCurrentPropertyValue(
            windows::Win32::UI::Accessibility::UIA_NativeWindowHandlePropertyId,
        )
        .map_err(|e| format!("Failed to get window handle: {e}"))?;
    let hwnd_val = hwnd_variant.Anonymous.Anonymous.Anonymous.lVal;
    let hwnd = windows::Win32::Foundation::HWND(hwnd_val as *mut _);
    let _ = windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow(hwnd);
    Ok(())
}

fn score_element_match(
    element: &IUIAutomationElement,
    fingerprint: &crate::commands::ElementFingerprint,
    actual_index: usize,
) -> u32 {
    let mut score = 0u32;

    // AutomationId match: highest weight (most stable, developer-assigned)
    if let Some(ref expected) = fingerprint.automation_id {
        if let Some(ref actual) = get_string_property(element, UIA_AutomationIdPropertyId) {
            if actual == expected {
                score += 100;
            } else {
                return 0; // Mismatched AutomationId is a strong disqualifier
            }
        }
    }

    // ControlType match: required
    let ct = get_control_type(element);
    if ct == fingerprint.control_type {
        score += 40;
    } else {
        return 0;
    }

    // ClassName match
    if let Some(ref expected) = fingerprint.class_name {
        if let Some(ref actual) = get_string_property(element, UIA_ClassNamePropertyId) {
            if actual == expected {
                score += 30;
            }
        }
    }

    // Name match
    if let Some(ref expected) = fingerprint.name {
        if let Some(ref actual) = get_element_name(element) {
            if actual == expected {
                score += 20;
            }
        }
    }

    // Index match: low weight tiebreaker
    if actual_index == fingerprint.child_index {
        score += 5;
    }

    score
}

unsafe fn find_matching_child(
    automation: &IUIAutomation,
    parent: &IUIAutomationElement,
    fingerprint: &crate::commands::ElementFingerprint,
) -> Result<IUIAutomationElement, String> {
    // Enumerate children and score each against the fingerprint
    let true_condition = automation
        .CreateTrueCondition()
        .map_err(|e| format!("Failed to create condition: {e}"))?;
    let children = parent
        .FindAll(TreeScope_Children, &true_condition)
        .map_err(|e| format!("Failed to enumerate children: {e}"))?;
    let count = children.Length().unwrap_or(0);

    let mut best_match: Option<(IUIAutomationElement, u32)> = None;

    for i in 0..count {
        if let Ok(child) = children.GetElement(i) {
            let s = score_element_match(&child, fingerprint, i as usize);
            if s > 0 && best_match.as_ref().is_none_or(|(_, bs)| s > *bs) {
                best_match = Some((child, s));
            }
        }
    }

    if let Some((el, _)) = best_match {
        return Ok(el);
    }

    // Fall back to positional index
    let idx = fingerprint.child_index as i32;
    if idx < count {
        return children
            .GetElement(idx)
            .map_err(|e| format!("Fallback index {} failed: {e}", idx));
    }

    Err("No matching child found for fingerprint".to_string())
}

unsafe fn resolve_element_by_fingerprint(
    automation: &IUIAutomation,
    app_pid: i32,
    chain: &[crate::commands::ElementFingerprint],
) -> Result<IUIAutomationElement, String> {
    let app_window = find_app_window(automation, app_pid)?;
    let mut current = app_window;

    for fingerprint in chain {
        current = find_matching_child(automation, &current, fingerprint)?;
    }

    Ok(current)
}

unsafe fn resolve_element(
    automation: &IUIAutomation,
    app_pid: i32,
    fingerprint_chain: Option<&[crate::commands::ElementFingerprint]>,
    index_path: &[usize],
) -> Result<IUIAutomationElement, String> {
    // Try fingerprint-based resolution first
    if let Some(chain) = fingerprint_chain {
        if !chain.is_empty() {
            match resolve_element_by_fingerprint(automation, app_pid, chain) {
                Ok(el) => return Ok(el),
                Err(e) => {
                    log::warn!("Fingerprint resolution failed ({e}), trying subtree search");

                    // If the target element has an AutomationId, search the
                    // window subtree directly. This handles Chrome/Electron
                    // where intermediate UI nodes shift but the leaf element
                    // has a stable AutomationId (e.g. "input", "RootWebArea").
                    if let Ok(el) = resolve_element_by_subtree_search(automation, app_pid, chain) {
                        return Ok(el);
                    }
                    log::warn!("Subtree search failed, falling back to index path");
                }
            }
        }
    }

    // Fall back to index-based resolution
    resolve_element_by_path(automation, app_pid, index_path)
}

/// Search the entire window subtree for an element matching the last
/// fingerprint's AutomationId + ControlType. This skips fragile
/// intermediate nodes in dynamic trees (Chrome, Electron, Edge).
unsafe fn resolve_element_by_subtree_search(
    automation: &IUIAutomation,
    app_pid: i32,
    chain: &[crate::commands::ElementFingerprint],
) -> Result<IUIAutomationElement, String> {
    let last = chain.last().ok_or("Empty fingerprint chain")?;
    let auto_id = last
        .automation_id
        .as_ref()
        .filter(|s| !s.is_empty())
        .ok_or("Target element has no AutomationId for subtree search")?;

    let app_window = find_app_window(automation, app_pid)?;

    // Build conditions: AutomationId == auto_id AND ControlType == control_type
    let id_variant = BSTR::from(auto_id.as_str());
    let id_cond = automation
        .CreatePropertyCondition(
            UIA_AutomationIdPropertyId,
            &windows::Win32::System::Variant::VARIANT::from(id_variant),
        )
        .map_err(|e| format!("Failed to create AutomationId condition: {e}"))?;

    let ct_cond = automation
        .CreatePropertyCondition(
            UIA_ControlTypePropertyId,
            &windows::Win32::System::Variant::VARIANT::from(last.control_type),
        )
        .map_err(|e| format!("Failed to create ControlType condition: {e}"))?;

    let combined = automation
        .CreateAndCondition(&id_cond, &ct_cond)
        .map_err(|e| format!("Failed to create combined condition: {e}"))?;

    // Search all descendants (UIA does this server-side, efficient)
    let found = app_window
        .FindFirst(
            windows::Win32::UI::Accessibility::TreeScope_Descendants,
            &combined,
        )
        .map_err(|e| format!("Subtree FindFirst failed: {e}"))?;

    // Verify we got a result (FindFirst may return null on no match)
    if found.CurrentProcessId().unwrap_or(0) == 0 {
        return Err("No matching element found in subtree".to_string());
    }

    // If the fingerprint also has a Name, verify it matches (extra safety)
    if let Some(ref expected_name) = last.name {
        if let Some(actual_name) = get_element_name(&found) {
            if &actual_name != expected_name {
                log::debug!(
                    "Subtree search: AutomationId matched but Name differs ('{}' vs '{}')",
                    actual_name,
                    expected_name
                );
                // Still return it — AutomationId is more stable than Name
            }
        }
    }

    log::info!(
        "Subtree search resolved element via AutomationId='{}'",
        auto_id
    );
    Ok(found)
}

fn should_skip_control_type(control_type: i32) -> bool {
    let skip_types = [
        0, // Unknown
        UIA_ThumbControlTypeId.0,
        UIA_TitleBarControlTypeId.0,
        UIA_ImageControlTypeId.0,
    ];
    skip_types.contains(&control_type)
}

fn is_container_control_type(control_type: i32) -> bool {
    let container_types = [
        UIA_TabControlTypeId.0,
        UIA_MenuControlTypeId.0,
        UIA_MenuBarControlTypeId.0,
        UIA_ToolBarControlTypeId.0,
        UIA_StatusBarControlTypeId.0,
        UIA_HeaderControlTypeId.0,
        UIA_PaneControlTypeId.0,
        UIA_GroupControlTypeId.0,
        UIA_DocumentControlTypeId.0,
        UIA_ListControlTypeId.0,
        UIA_TableControlTypeId.0,
        UIA_TreeControlTypeId.0,
        UIA_DataGridControlTypeId.0,
        UIA_CustomControlTypeId.0,
        UIA_CalendarControlTypeId.0,
        UIA_SemanticZoomControlTypeId.0,
        UIA_AppBarControlTypeId.0,
    ];
    container_types.contains(&control_type)
}

pub fn get_focused_field_info() -> Option<crate::commands::AccessibilityFieldInfo> {
    run_on_uia_thread(|| match try_get_focused_field_info() {
        Ok(info) => info,
        Err(e) => {
            log::error!("Error getting focused field info: {:?}", e);
            None
        }
    })
}

fn is_java_process_name(name: Option<&str>) -> bool {
    name.map(|n| {
        let lower = n.to_ascii_lowercase();
        lower == "java.exe"
            || lower == "javaw.exe"
            || lower == "javaws.exe"
            || lower.starts_with("java")
            || lower.contains("openwebstart")
    })
    .unwrap_or(false)
}

fn try_get_focused_field_info(
) -> Result<Option<crate::commands::AccessibilityFieldInfo>, windows::core::Error> {
    with_automation(|automation| unsafe {
        let focused = automation.GetFocusedElement()?;

        // Get the process ID early so we can detect Java
        let mut app_pid: Option<i32> = None;
        if let Ok(pid_variant) = focused
            .GetCurrentPropertyValue(windows::Win32::UI::Accessibility::UIA_ProcessIdPropertyId)
        {
            let pid_val = pid_variant.Anonymous.Anonymous.Anonymous.lVal;
            if pid_val > 0 {
                app_pid = Some(pid_val);
            }
        }
        let app_name = app_pid.and_then(|pid| get_process_name(pid as u32));

        // Detect Java process — delegate to JAB if so
        let is_java = is_java_process_name(app_name.as_deref())
            || get_string_property(&focused, UIA_FrameworkIdPropertyId)
                .as_deref()
                .map(|f| f == "Java" || f == "JavaFX")
                .unwrap_or(false);

        let app_identity = app_pid.and_then(|pid| capture_app_identity(pid as u32));

        if is_java {
            let hwnd = windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow();
            if !hwnd.0.is_null() {
                let window_title = get_element_name(&automation.ElementFromHandle(hwnd)?);
                if let Some(mut jab_info) = super::jab::jab_get_focused_field_info(
                    hwnd,
                    app_pid.unwrap_or(0),
                    app_name.as_deref(),
                    window_title,
                ) {
                    jab_info.app_identity = app_identity.clone();
                    return Ok(Some(jab_info));
                }
                log::warn!("JAB focused field detection failed, falling through to UIA path");
            }
        }

        let role = {
            let ct = get_control_type(&focused);
            Some(control_type_name(ct))
        };
        let title = get_element_name(&focused);
        let description = get_element_help_text(&focused);
        let value = get_element_value(&focused);

        // Check if the value pattern is available and not read-only
        let is_settable = focused
            .GetCurrentPattern(UIA_ValuePatternId)
            .ok()
            .filter(|p| !p.as_raw().is_null())
            .and_then(|p| p.cast::<IUIAutomationValuePattern>().ok())
            .and_then(|vp| vp.CurrentIsReadOnly().ok())
            .map(|ro| !ro.as_bool())
            .unwrap_or(false);

        // Determine can_paste: element can receive paste if it's focusable and
        // either not settable via ValuePattern or has TextPattern support
        let can_paste = {
            let has_text_pattern = focused
                .GetCurrentPattern(UIA_TextPatternId)
                .map(|p| !p.as_raw().is_null())
                .unwrap_or(false);
            let ct = get_control_type(&focused);
            let is_editable_type = ct == UIA_EditControlTypeId.0
                || ct == UIA_DocumentControlTypeId.0
                || ct == UIA_ComboBoxControlTypeId.0;
            !is_settable && (has_text_pattern || is_editable_type)
        };

        // Walk up to find the window title and build the index path + fingerprint chain
        let tree_walker = automation.ControlViewWalker()?;
        let mut window_title: Option<String> = None;
        let mut element_index_path: Vec<usize> = Vec::new();
        let mut fingerprint_chain: Vec<crate::commands::ElementFingerprint> = Vec::new();

        let mut current = focused.clone();
        let mut levels_up = 0;

        while levels_up < MAX_LEVELS_UP {
            let parent = match tree_walker.GetParentElement(&current) {
                Ok(p) => p,
                Err(_) => break,
            };

            // Find the index of current among parent's children
            let true_condition = automation.CreateTrueCondition()?;
            if let Ok(children) = parent.FindAll(TreeScope_Children, &true_condition) {
                let count = children.Length().unwrap_or(0);
                for i in 0..count {
                    if let Ok(sibling) = children.GetElement(i) {
                        let comparison = automation.CompareElements(&current, &sibling)?;
                        if comparison.as_bool() {
                            element_index_path.push(i as usize);
                            fingerprint_chain.push(build_element_fingerprint(&current, i as usize));
                            break;
                        }
                    }
                }
            }

            let ct = get_control_type(&parent);
            if ct == UIA_WindowControlTypeId.0 {
                window_title = get_element_name(&parent);
                break;
            }

            current = parent;
            levels_up += 1;
        }

        element_index_path.reverse();
        fingerprint_chain.reverse();

        Ok(Some(crate::commands::AccessibilityFieldInfo {
            role,
            title,
            description,
            value,
            placeholder: None,
            app_pid,
            app_name,
            window_title,
            is_settable,
            element_index_path,
            fingerprint_chain,
            can_paste,
            backend: None,
            jab_string_path: vec![],
            app_identity,
            details: None,
        }))
    })
}

pub fn read_field_values(fields: Vec<FieldValueRequest>) -> Vec<FieldValueResult> {
    run_on_uia_thread(move || {
        match with_automation(|automation| unsafe {
            Ok(fields
                .iter()
                .map(|field| {
                    // JAB path
                    if field.backend.as_deref() == Some("jab") {
                        return match super::jab::find_hwnd_for_pid(field.app_pid as u32) {
                            Some(hwnd) => {
                                match super::jab::jab_read_text(
                                    hwnd,
                                    field.jab_string_path.as_deref(),
                                    &field.element_index_path,
                                ) {
                                    Ok(value) => FieldValueResult { value, error: None },
                                    Err(e) => FieldValueResult {
                                        value: None,
                                        error: Some(e),
                                    },
                                }
                            }
                            None => FieldValueResult {
                                value: None,
                                error: Some(format!("No window for PID {}", field.app_pid)),
                            },
                        };
                    }

                    // UIA path
                    match resolve_element(
                        automation,
                        field.app_pid,
                        field.fingerprint_chain.as_deref(),
                        &field.element_index_path,
                    ) {
                        Ok(element) => {
                            // Try ValuePattern first
                            if let Some(val) = get_element_value(&element) {
                                return FieldValueResult {
                                    value: Some(val),
                                    error: None,
                                };
                            }
                            // Try TextPattern
                            let pattern = element.GetCurrentPattern(UIA_TextPatternId).ok();
                            if let Some(p) = pattern.filter(|p| !p.as_raw().is_null()) {
                                if let Ok(tp) = p.cast::<IUIAutomationTextPattern>() {
                                    if let Ok(range) = tp.DocumentRange() {
                                        if let Ok(text) = range.GetText(2000) {
                                            let s = text.to_string();
                                            if !s.is_empty() {
                                                return FieldValueResult {
                                                    value: Some(s),
                                                    error: None,
                                                };
                                            }
                                        }
                                    }
                                }
                            }
                            FieldValueResult {
                                value: Some(String::new()),
                                error: None,
                            }
                        }
                        Err(e) => FieldValueResult {
                            value: None,
                            error: Some(e),
                        },
                    }
                })
                .collect())
        }) {
            Ok(results) => results,
            Err(e) => {
                let err = format!("Failed to create UIAutomation: {e}");
                fields
                    .iter()
                    .map(|_| FieldValueResult {
                        value: None,
                        error: Some(err.clone()),
                    })
                    .collect()
            }
        }
    })
}

fn resolve_element_by_path(
    automation: &IUIAutomation,
    app_pid: i32,
    index_path: &[usize],
) -> Result<IUIAutomationElement, String> {
    unsafe {
        let root = automation
            .GetRootElement()
            .map_err(|e| format!("Failed to get root element: {e}"))?;

        // Find the window belonging to this PID
        let true_condition = automation
            .CreateTrueCondition()
            .map_err(|e| format!("Failed to create condition: {e}"))?;

        let top_level_windows = root
            .FindAll(TreeScope_Children, &true_condition)
            .map_err(|e| format!("Failed to enumerate windows: {e}"))?;

        let count = top_level_windows
            .Length()
            .map_err(|e| format!("Failed to get window count: {e}"))?;

        let mut app_window: Option<IUIAutomationElement> = None;
        for i in 0..count {
            if let Ok(win) = top_level_windows.GetElement(i) {
                let pid_variant = win.GetCurrentPropertyValue(
                    windows::Win32::UI::Accessibility::UIA_ProcessIdPropertyId,
                );
                if let Ok(pv) = pid_variant {
                    let win_pid = pv.Anonymous.Anonymous.Anonymous.lVal;
                    if win_pid == app_pid {
                        app_window = Some(win);
                        break;
                    }
                }
            }
        }

        let mut current = app_window.ok_or_else(|| format!("No window found for PID {app_pid}"))?;

        for &index in index_path {
            let children_condition = automation
                .CreateTrueCondition()
                .map_err(|e| format!("Failed to create condition: {e}"))?;
            let children = current
                .FindAll(TreeScope_Children, &children_condition)
                .map_err(|e| format!("Failed to enumerate children: {e}"))?;
            let child_count = children
                .Length()
                .map_err(|e| format!("Failed to get child count: {e}"))?
                as usize;

            if index >= child_count {
                return Err(format!(
                    "Child index {index} out of range (count={child_count})"
                ));
            }

            current = children
                .GetElement(index as i32)
                .map_err(|e| format!("Failed to get child at index {index}: {e}"))?;
        }

        Ok(current)
    }
}

pub fn focus_accessibility_field(
    app_pid: i32,
    element_index_path: &[usize],
    fingerprint_chain: Option<&[crate::commands::ElementFingerprint]>,
    backend: Option<&str>,
    jab_string_path: Option<&[crate::commands::JabElementId]>,
) -> Result<(), String> {
    // JAB path — doesn't need UIA, skip the STA thread
    if backend == Some("jab") {
        let hwnd = super::jab::find_hwnd_for_pid(app_pid as u32)
            .ok_or_else(|| format!("No window found for PID {app_pid}"))?;
        unsafe {
            let _ = windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow(hwnd);
        }
        return super::jab::jab_focus_element(hwnd, jab_string_path, element_index_path);
    }

    // Clone ref data so the closure is 'static
    let index_path = element_index_path.to_vec();
    let fp_chain = fingerprint_chain.map(|fc| fc.to_vec());

    run_on_uia_thread(move || {
        let result: Result<(), String> = (|| unsafe {
            let automation = with_automation(|a| Ok(a.clone()))
                .map_err(|e| format!("Failed to create UIAutomation: {e}"))?;

            // Bring the app window to the foreground
            if let Ok(win) = find_app_window(&automation, app_pid) {
                let _ = bring_window_to_foreground(&win);
            }

            // Resolve the target element
            let element = resolve_element(&automation, app_pid, fp_chain.as_deref(), &index_path)?;

            // Focus the element by calling SetFocus
            element
                .SetFocus()
                .map_err(|e| format!("Failed to set focus: {e}"))?;

            // Set cursor to a random position if the element has a text pattern
            let text_pattern_raw = element
                .GetCurrentPattern(UIA_TextPatternId)
                .map_err(|e| format!("Failed to get text pattern: {e}"))?;

            if !text_pattern_raw.as_raw().is_null() {
                let text_pattern: IUIAutomationTextPattern = text_pattern_raw
                    .cast()
                    .map_err(|e| format!("Failed to cast text pattern: {e}"))?;

                let doc_range = text_pattern
                    .DocumentRange()
                    .map_err(|e| format!("Failed to get document range: {e}"))?;

                let full_text: BSTR = doc_range.GetText(-1).unwrap_or_default();
                let text_len = full_text.to_string().len();

                if text_len > 0 {
                    let position = (std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .subsec_nanos() as usize)
                        % (text_len + 1);

                    let cursor_range = doc_range
                        .Clone()
                        .map_err(|e| format!("Failed to clone range: {e}"))?;

                    cursor_range
                        .MoveEndpointByRange(
                            windows::Win32::UI::Accessibility::TextPatternRangeEndpoint_End,
                            &doc_range,
                            windows::Win32::UI::Accessibility::TextPatternRangeEndpoint_Start,
                        )
                        .ok();

                    use windows::Win32::UI::Accessibility::TextUnit_Character;
                    cursor_range.Move(TextUnit_Character, position as i32).ok();

                    cursor_range.Select().ok();
                }
            }

            Ok(())
        })();
        result
    })
}

pub fn write_accessibility_fields(
    entries: Vec<crate::commands::AccessibilityWriteEntry>,
) -> crate::commands::AccessibilityWriteResult {
    let entry_count = entries.len();
    run_on_uia_thread(move || {
        let automation = match with_automation(|a| Ok(a.clone())) {
            Ok(a) => a,
            Err(e) => {
                return crate::commands::AccessibilityWriteResult {
                    succeeded: 0,
                    failed: entry_count,
                    errors: vec![format!("Failed to create UIAutomation: {e}")],
                };
            }
        };

        let mut succeeded = 0usize;
        let mut failed = 0usize;
        let mut errors: Vec<String> = Vec::new();

        for entry in &entries {
            // JAB path
            if entry.backend.as_deref() == Some("jab") {
                use crate::commands::JabWriteMethod;

                match super::jab::find_hwnd_for_pid(entry.app_pid as u32) {
                    Some(hwnd) => {
                        let result: Result<(), String> = match &entry.jab_write_method {
                            JabWriteMethod::SetTextContents => {
                                log::info!(
                                    "JAB write via setTextContents for PID {}",
                                    entry.app_pid
                                );
                                super::jab::jab_write_text(
                                    hwnd,
                                    entry.jab_string_path.as_deref(),
                                    &entry.element_index_path,
                                    &entry.value,
                                )
                            }
                            JabWriteMethod::ClipboardPaste => {
                                log::info!(
                                    "JAB write via clipboard paste for PID {}",
                                    entry.app_pid
                                );
                                unsafe {
                                    let _ = windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow(hwnd);
                                }
                                super::jab::jab_focus_element(
                                    hwnd,
                                    entry.jab_string_path.as_deref(),
                                    &entry.element_index_path,
                                )
                                .and_then(|()| {
                                    std::thread::sleep(std::time::Duration::from_millis(100));
                                    super::input::select_all_keystroke();
                                    std::thread::sleep(std::time::Duration::from_millis(50));
                                    // write_accessibility_fields must never restore the
                                    // clipboard — the caller owns clipboard state and a
                                    // delayed restore races with subsequent writes.
                                    super::input::paste_text_into_focused_field(
                                        &entry.value,
                                        None,
                                        true,
                                    )
                                    .map(|_| ())
                                })
                            }
                            JabWriteMethod::KeystrokeSimulation => {
                                log::info!(
                                    "JAB write via keystroke simulation for PID {}",
                                    entry.app_pid
                                );
                                unsafe {
                                    let _ = windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow(hwnd);
                                }
                                super::jab::jab_focus_element(
                                    hwnd,
                                    entry.jab_string_path.as_deref(),
                                    &entry.element_index_path,
                                )
                                .and_then(|()| {
                                    std::thread::sleep(std::time::Duration::from_millis(100));
                                    super::input::select_all_keystroke();
                                    std::thread::sleep(std::time::Duration::from_millis(50));
                                    super::input::type_text_via_keystrokes(&entry.value)
                                })
                            }
                            JabWriteMethod::KeystrokeSimulationSmart => {
                                log::info!(
                                    "JAB write via smart keystroke diff for PID {}",
                                    entry.app_pid
                                );
                                unsafe {
                                    let _ = windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow(hwnd);
                                }
                                super::jab::jab_focus_element(
                                    hwnd,
                                    entry.jab_string_path.as_deref(),
                                    &entry.element_index_path,
                                )
                                .and_then(|()| {
                                    std::thread::sleep(std::time::Duration::from_millis(100));
                                    jab_smart_write(
                                        hwnd,
                                        entry.jab_string_path.as_deref(),
                                        &entry.element_index_path,
                                        &entry.value,
                                    )
                                })
                            }
                        };
                        match result {
                            Ok(()) => {
                                succeeded += 1;
                            }
                            Err(e) => {
                                failed += 1;
                                errors.push(format!(
                                    "JAB write failed for PID {}: {e}",
                                    entry.app_pid
                                ));
                            }
                        }
                        continue;
                    }
                    None => {
                        failed += 1;
                        errors.push(format!("No window found for PID {}", entry.app_pid));
                        continue;
                    }
                }
            }

            // UIA path
            let element = match unsafe {
                resolve_element(
                    &automation,
                    entry.app_pid,
                    entry.fingerprint_chain.as_deref(),
                    &entry.element_index_path,
                )
            } {
                Ok(el) => el,
                Err(e) => {
                    failed += 1;
                    errors.push(e);
                    continue;
                }
            };

            // Bring window to foreground, focus element, select-all + paste
            unsafe {
                if let Ok(win) = find_app_window(&automation, entry.app_pid) {
                    let _ = bring_window_to_foreground(&win);
                }
            }
            match unsafe { try_write_via_paste(&element, &entry.value) } {
                Ok(()) => succeeded += 1,
                Err(paste_err) => {
                    failed += 1;
                    errors.push(format!(
                        "Write failed for PID {} path {:?}: paste failed: {paste_err}",
                        entry.app_pid, entry.element_index_path
                    ));
                }
            }
        }

        crate::commands::AccessibilityWriteResult {
            succeeded,
            failed,
            errors,
        }
    })
}

// ---------------------------------------------------------------------------
// Smart diff for keystroke simulation
// ---------------------------------------------------------------------------

struct EditRegion {
    /// Char offset in the old text where this edit starts.
    old_start: usize,
    /// Char offset in the old text where this edit ends (exclusive).
    old_end: usize,
    /// Replacement text for the old_start..old_end range.
    new_text: String,
}

/// Find the longest matching sub-slice between `a` and `b`.
/// Returns `(index_in_a, index_in_b, length)` or `None`.
fn find_longest_match(a: &[char], b: &[char], min_len: usize) -> Option<(usize, usize, usize)> {
    let mut best = (0, 0, 0usize);
    for i in 0..a.len() {
        for j in 0..b.len() {
            let mut k = 0;
            while i + k < a.len() && j + k < b.len() && a[i + k] == b[j + k] {
                k += 1;
            }
            if k > best.2 {
                best = (i, j, k);
            }
        }
    }
    if best.2 >= min_len {
        Some(best)
    } else {
        None
    }
}

/// Recursively find all matching blocks between old and new char slices.
/// Returns sorted `(old_idx, new_idx, length)` triples.
fn find_matching_blocks(
    old: &[char],
    new: &[char],
    old_offset: usize,
    new_offset: usize,
) -> Vec<(usize, usize, usize)> {
    const MIN_MATCH: usize = 2;
    match find_longest_match(old, new, MIN_MATCH) {
        Some((oi, ni, mlen)) => {
            let mut blocks = Vec::new();
            if oi > 0 && ni > 0 {
                blocks.extend(find_matching_blocks(
                    &old[..oi],
                    &new[..ni],
                    old_offset,
                    new_offset,
                ));
            }
            blocks.push((old_offset + oi, new_offset + ni, mlen));
            let ro = oi + mlen;
            let rn = ni + mlen;
            if ro < old.len() && rn < new.len() {
                blocks.extend(find_matching_blocks(
                    &old[ro..],
                    &new[rn..],
                    old_offset + ro,
                    new_offset + rn,
                ));
            }
            blocks
        }
        None => vec![],
    }
}

/// Compute the minimal set of edit regions needed to transform `old` into `new`.
fn compute_edit_regions(old: &str, new: &str) -> Vec<EditRegion> {
    let old_c: Vec<char> = old.chars().collect();
    let new_c: Vec<char> = new.chars().collect();
    let blocks = find_matching_blocks(&old_c, &new_c, 0, 0);

    let mut edits = Vec::new();
    let mut oi = 0usize;
    let mut ni = 0usize;
    for &(bo, bn, blen) in &blocks {
        if oi < bo || ni < bn {
            edits.push(EditRegion {
                old_start: oi,
                old_end: bo,
                new_text: new_c[ni..bn].iter().collect(),
            });
        }
        oi = bo + blen;
        ni = bn + blen;
    }
    if oi < old_c.len() || ni < new_c.len() {
        edits.push(EditRegion {
            old_start: oi,
            old_end: old_c.len(),
            new_text: new_c[ni..].iter().collect(),
        });
    }
    edits
}

/// Apply a smart diff write to a JAB element: read current text, compute
/// minimal edits, and apply them via cursor positioning + keystrokes.
fn jab_smart_write(
    hwnd: windows::Win32::Foundation::HWND,
    string_path: Option<&[crate::commands::JabElementId]>,
    index_path: &[usize],
    desired: &str,
) -> Result<(), String> {
    let current = super::jab::jab_read_text(hwnd, string_path, index_path)?.unwrap_or_default();

    if current == desired {
        log::info!("JAB smart write: text already matches, no edits needed");
        return Ok(());
    }

    let edits = compute_edit_regions(&current, desired);
    log::info!(
        "JAB smart write: {} edit region(s) to transform {} chars → {} chars",
        edits.len(),
        current.len(),
        desired.len(),
    );

    // Apply edits right-to-left so earlier positions aren't shifted.
    for edit in edits.iter().rev() {
        let old_len = edit.old_end - edit.old_start;

        super::jab::jab_set_caret_position(hwnd, string_path, index_path, edit.old_start)?;
        std::thread::sleep(std::time::Duration::from_millis(30));

        if old_len > 0 {
            super::input::shift_select_right(old_len);
            std::thread::sleep(std::time::Duration::from_millis(20));
        }

        if !edit.new_text.is_empty() {
            // Typing with a selection replaces the selected text.
            super::input::type_text_via_keystrokes(&edit.new_text)?;
            std::thread::sleep(std::time::Duration::from_millis(30));
        } else if old_len > 0 {
            // Pure deletion — remove the selection.
            super::input::send_delete_keystroke();
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    Ok(())
}

#[allow(dead_code)]
unsafe fn try_write_via_value_pattern(element: &IUIAutomationElement, value: &str) -> bool {
    let pattern = match element.GetCurrentPattern(UIA_ValuePatternId) {
        Ok(p) if !p.as_raw().is_null() => p,
        _ => return false,
    };
    let value_pattern: IUIAutomationValuePattern = match pattern.cast() {
        Ok(vp) => vp,
        Err(_) => return false,
    };
    if value_pattern
        .CurrentIsReadOnly()
        .unwrap_or_default()
        .as_bool()
    {
        return false;
    }
    let bstr = BSTR::from(value);
    value_pattern.SetValue(&bstr).is_ok()
}

unsafe fn try_write_via_paste(element: &IUIAutomationElement, value: &str) -> Result<(), String> {
    element
        .SetFocus()
        .map_err(|e| format!("SetFocus failed: {e}"))?;
    std::thread::sleep(std::time::Duration::from_millis(100));

    // Select all existing content then paste to replace
    super::input::select_all_keystroke();
    std::thread::sleep(std::time::Duration::from_millis(50));

    // write_accessibility_fields must never restore the clipboard — the caller
    // owns clipboard state and a delayed restore races with subsequent writes.
    super::input::paste_text_into_focused_field(value, None, true).map(|_| ())
}

fn get_process_name(pid: u32) -> Option<String> {
    let path = get_process_exe_path(pid)?;
    path.rsplit('\\').next().map(|s| s.to_string())
}

/// Retrieve a process's executable path. Uses `QueryFullProcessImageNameW`
/// rather than `GetModuleFileNameExW` because the former only needs
/// `PROCESS_QUERY_LIMITED_INFORMATION` and works cleanly cross-bitness
/// (critical for 64-bit Voquill enumerating JVM processes and vice versa).
fn get_process_exe_path(pid: u32) -> Option<String> {
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut size: u32 = buf.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut size,
        );
        let _ = windows::Win32::Foundation::CloseHandle(handle);
        if result.is_err() || size == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..size as usize]))
    }
}

pub fn capture_app_identity(pid: u32) -> Option<crate::commands::AppIdentity> {
    let exe_path = get_process_exe_path(pid)?;
    let exe_name = exe_path.rsplit('\\').next().map(|s| s.to_string());
    Some(crate::commands::AppIdentity {
        exe_path: Some(exe_path),
        exe_name,
        bundle_id: None,
    })
}

pub fn resolve_app_pids(
    identity: &crate::commands::AppIdentity,
) -> Vec<crate::commands::AppProcessMatch> {
    use windows::Win32::System::ProcessStatus::EnumProcesses;

    let expected_path = identity.exe_path.as_deref().map(|s| s.to_lowercase());
    let expected_name = identity.exe_name.as_deref().map(|s| s.to_lowercase());
    if expected_path.is_none() && expected_name.is_none() {
        log::warn!("resolve_app_pids: empty identity, returning no matches");
        return Vec::new();
    }
    log::info!(
        "resolve_app_pids: searching for path={:?} name={:?}",
        expected_path,
        expected_name
    );

    let mut pid_buf = vec![0u32; 4096];
    let mut bytes_returned: u32 = 0;
    let ok = unsafe {
        EnumProcesses(
            pid_buf.as_mut_ptr(),
            (pid_buf.len() * std::mem::size_of::<u32>()) as u32,
            &mut bytes_returned,
        )
    };
    if ok.is_err() {
        log::error!("resolve_app_pids: EnumProcesses failed");
        return Vec::new();
    }
    let pid_count = bytes_returned as usize / std::mem::size_of::<u32>();
    pid_buf.truncate(pid_count);
    log::info!("resolve_app_pids: enumerated {} PIDs", pid_count);

    let titles_by_pid = enumerate_visible_window_titles();

    // Collect every process we could read a path for, remember which matched
    // by full path and which only matched by basename. `None` == couldn't read
    // the path (probably an access-denied PID).
    struct Candidate {
        pid: u32,
        path: String,
        name: String,
        matched_path: bool,
        matched_name: bool,
    }
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut name_only_hits = 0;
    for pid in pid_buf {
        if pid == 0 {
            continue;
        }
        let Some(path) = get_process_exe_path(pid) else {
            continue;
        };
        let path_lc = path.to_lowercase();
        let name_lc = path
            .rsplit('\\')
            .next()
            .map(|s| s.to_lowercase())
            .unwrap_or_default();
        let matched_path = expected_path
            .as_deref()
            .map(|e| path_lc == e)
            .unwrap_or(false);
        let matched_name = expected_name
            .as_deref()
            .map(|e| name_lc == *e)
            .unwrap_or(false);
        if !matched_path && !matched_name {
            continue;
        }
        if matched_name && !matched_path {
            name_only_hits += 1;
        }
        candidates.push(Candidate {
            pid,
            path,
            name: name_lc,
            matched_path,
            matched_name,
        });
    }
    log::info!(
        "resolve_app_pids: candidates: {} total, {} name-only hits",
        candidates.len(),
        name_only_hits
    );

    // Prefer full-path matches when we have any, else fall back to name-only
    // matches. Keeps exe_path as the authoritative signal while tolerating a
    // shifted install directory on a different machine.
    let have_full_path_hit = candidates.iter().any(|c| c.matched_path);
    let mut matches = Vec::new();
    for c in candidates {
        let keep = if have_full_path_hit {
            c.matched_path
        } else {
            c.matched_name
        };
        if !keep {
            continue;
        }
        let window_title = titles_by_pid
            .get(&c.pid)
            .and_then(|titles| titles.first().cloned());
        let app_name = Some(c.name.clone());
        log::info!(
            "resolve_app_pids: match pid={} path={} window={:?}",
            c.pid,
            c.path,
            window_title
        );
        matches.push(crate::commands::AppProcessMatch {
            pid: c.pid as i32,
            exe_path: Some(c.path),
            app_name,
            window_title,
        });
    }
    log::info!("resolve_app_pids: returning {} matches", matches.len());
    matches
}

fn enumerate_visible_window_titles() -> std::collections::HashMap<u32, Vec<String>> {
    use std::collections::HashMap;
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowExW, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible,
    };

    let mut titles: HashMap<u32, Vec<String>> = HashMap::new();
    unsafe {
        let mut hwnd = match FindWindowExW(None, None, None, None) {
            Ok(h) => h,
            Err(_) => return titles,
        };
        loop {
            if IsWindowVisible(hwnd).as_bool() {
                let len = GetWindowTextLengthW(hwnd);
                if len > 0 {
                    let mut buf = vec![0u16; (len + 1) as usize];
                    let got = GetWindowTextW(hwnd, &mut buf);
                    if got > 0 {
                        let title = String::from_utf16_lossy(&buf[..got as usize]);
                        let mut pid: u32 = 0;
                        GetWindowThreadProcessId(hwnd, Some(&mut pid));
                        if pid > 0 && !title.is_empty() {
                            titles.entry(pid).or_default().push(title);
                        }
                    }
                }
            }
            match FindWindowExW(None, Some(hwnd), None, None) {
                Ok(next) => hwnd = next,
                Err(_) => break,
            }
        }
    }
    titles
}

fn control_type_name(ct: i32) -> String {
    match ct {
        x if x == UIA_EditControlTypeId.0 => "Edit".to_string(),
        x if x == UIA_DocumentControlTypeId.0 => "Document".to_string(),
        x if x == UIA_TextControlTypeId.0 => "Text".to_string(),
        x if x == UIA_ButtonControlTypeId.0 => "Button".to_string(),
        x if x == UIA_ComboBoxControlTypeId.0 => "ComboBox".to_string(),
        x if x == UIA_ListItemControlTypeId.0 => "ListItem".to_string(),
        x if x == UIA_WindowControlTypeId.0 => "Window".to_string(),
        x if x == UIA_GroupControlTypeId.0 => "Group".to_string(),
        x if x == UIA_PaneControlTypeId.0 => "Pane".to_string(),
        x if x == UIA_CheckBoxControlTypeId.0 => "CheckBox".to_string(),
        x if x == UIA_RadioButtonControlTypeId.0 => "RadioButton".to_string(),
        x if x == UIA_TabItemControlTypeId.0 => "TabItem".to_string(),
        x if x == UIA_MenuItemControlTypeId.0 => "MenuItem".to_string(),
        x if x == UIA_HyperlinkControlTypeId.0 => "Hyperlink".to_string(),
        x if x == UIA_TreeItemControlTypeId.0 => "TreeItem".to_string(),
        x if x == UIA_SliderControlTypeId.0 => "Slider".to_string(),
        x if x == UIA_CustomControlTypeId.0 => "Custom".to_string(),
        _ => format!("ControlType({ct})"),
    }
}

pub fn get_selected_text() -> Option<String> {
    run_on_uia_thread(|| {
        if let Ok(Some(text)) = try_get_selected_text_uia() {
            return Some(text);
        }
        get_selected_text_clipboard()
    })
}

pub fn check_focused_paste_target() -> crate::commands::PasteTargetState {
    use crate::commands::PasteTargetState;

    // Shell surfaces (desktop wallpaper / icons) never accept pasted text:
    // Progman hosts the desktop, WorkerW is its sibling when a wallpaper
    // slideshow or Web-content desktop is active. UIA reports the focused
    // element as a ListItem here, which we otherwise treat as potentially
    // editable.
    let fg = super::input::get_foreground_window_target_info();
    if let Some(cls) = fg.class_name.as_deref() {
        if cls == "Progman" || cls == "WorkerW" {
            return PasteTargetState::NotEditable;
        }
    }

    match try_is_text_input_focused() {
        Ok(true) => PasteTargetState::Editable,
        Ok(false) => PasteTargetState::NotEditable,
        Err(_) => PasteTargetState::Unknown,
    }
}

fn try_get_selected_text_uia() -> Result<Option<String>, windows::core::Error> {
    with_automation(|automation| unsafe {
        let focused = automation.GetFocusedElement()?;

        let pattern = focused.GetCurrentPattern(UIA_TextPatternId)?;

        if pattern.as_raw().is_null() {
            return Ok(None);
        }

        let text_pattern: IUIAutomationTextPattern = pattern.cast()?;

        let selections = text_pattern.GetSelection()?;
        let selection_count = selections.Length()?;

        if selection_count > 0 {
            let selection = selections.GetElement(0)?;
            let selection_text: BSTR = selection.GetText(-1)?;
            let text = selection_text.to_string();
            if !text.is_empty() {
                return Ok(Some(text));
            }
        }

        Ok(None)
    })
}

fn get_selected_text_clipboard() -> Option<String> {
    use std::{thread, time::Duration};

    let mut clipboard = arboard::Clipboard::new().ok()?;
    let previous = crate::platform::SavedClipboard::save(&mut clipboard);
    clipboard.clear().ok();

    super::input::simulate_copy_keystroke();
    thread::sleep(Duration::from_millis(50));

    let selected = clipboard.get_text().ok();

    thread::spawn(move || {
        thread::sleep(Duration::from_millis(100));
        previous.restore();
    });

    selected.filter(|s| !s.is_empty())
}
