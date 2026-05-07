#![allow(clippy::missing_safety_doc)]

use crate::commands::{ScreenContextInfo, TextFieldInfo};
use core_foundation::array::{CFArrayGetCount, CFArrayGetValueAtIndex};
use core_foundation::base::{CFGetTypeID, CFRelease, CFTypeRef, TCFType};
use core_foundation::string::{CFString, CFStringGetTypeID, CFStringRef};
use std::ffi::c_void;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;

extern "C" {
    fn dispatch_sync_f(queue: *mut c_void, context: *mut c_void, work: extern "C" fn(*mut c_void));
    static _dispatch_main_q: u8;
}

fn run_on_main_thread<F, R>(f: F) -> R
where
    F: FnOnce() -> R + Send,
    R: Send,
{
    struct Context<F, R> {
        f: Option<F>,
        result: Option<R>,
    }

    extern "C" fn trampoline<F, R>(ctx: *mut c_void)
    where
        F: FnOnce() -> R,
    {
        unsafe {
            let ctx = &mut *(ctx as *mut Context<F, R>);
            let f = ctx.f.take().unwrap();
            ctx.result = Some(f());
        }
    }

    let mut ctx = Context {
        f: Some(f),
        result: None,
    };

    unsafe {
        let main_q = &_dispatch_main_q as *const u8 as *mut c_void;
        dispatch_sync_f(
            main_q,
            &mut ctx as *mut Context<F, R> as *mut c_void,
            trampoline::<F, R>,
        );
    }

    ctx.result.unwrap()
}

// AXUIElement types and functions from ApplicationServices framework
type AXUIElementRef = CFTypeRef;
type AXError = i32;

const AX_ERROR_SUCCESS: AXError = 0;

// AXValue type constants
const AX_VALUE_TYPE_CG_POINT: i32 = 1;
const AX_VALUE_TYPE_CG_SIZE: i32 = 2;
const AX_VALUE_TYPE_CF_RANGE: i32 = 4;

#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct CFRange {
    location: isize,
    length: isize,
}

#[link(name = "ApplicationServices", kind = "framework")]
#[allow(dead_code)]
extern "C" {
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: CFTypeRef,
    ) -> AXError;
    fn AXUIElementIsAttributeSettable(
        element: AXUIElementRef,
        attribute: CFStringRef,
        settable: *mut bool,
    ) -> AXError;
    fn AXValueGetValue(value: CFTypeRef, value_type: i32, out: *mut c_void) -> bool;
    fn AXValueCreate(value_type: i32, value: *const c_void) -> CFTypeRef;
    fn AXUIElementGetPid(element: AXUIElementRef, pid: *mut i32) -> AXError;
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementCopyElementAtPosition(
        application: AXUIElementRef,
        x: f32,
        y: f32,
        element: *mut CFTypeRef,
    ) -> AXError;
    fn AXUIElementPerformAction(element: AXUIElementRef, action: CFStringRef) -> AXError;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreate(source: CFTypeRef) -> CFTypeRef;
    fn CGEventGetLocation(event: CFTypeRef) -> core_graphics::geometry::CGPoint;
}

/// Append a trace line to /Users/josiah/Downloads/voquill-binding-debug.log.
/// Used to capture a full picture of what bind/resolve/paste does on a real
/// run, since stdout logging gets lost in Tauri's combined output.
fn debug_log(msg: &str) {
    use std::io::Write;
    let path = "/Users/josiah/Downloads/voquill-binding-debug.log";
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let _ = writeln!(f, "[{ts}] {msg}");
    }
}

fn fp_summary(fp: &crate::commands::ElementFingerprint) -> String {
    format!(
        "{{role={:?} subrole={:?} title={:?} desc={:?} id={:?} child_index={}}}",
        fp.ax_role, fp.ax_subrole, fp.ax_title, fp.ax_description, fp.ax_identifier, fp.child_index,
    )
}

fn chain_summary(chain: &[crate::commands::ElementFingerprint]) -> String {
    if chain.is_empty() {
        return "<empty>".to_string();
    }
    chain
        .iter()
        .enumerate()
        .map(|(i, fp)| format!("[{i}] {}", fp_summary(fp)))
        .collect::<Vec<_>>()
        .join(" / ")
}

unsafe fn snapshot_element(label: &str, element: CFTypeRef) -> String {
    let role = get_string_attribute(element, CFString::new("AXRole").as_concrete_TypeRef());
    let subrole = get_string_attribute(element, CFString::new("AXSubrole").as_concrete_TypeRef());
    let title = get_string_attribute(element, CFString::new("AXTitle").as_concrete_TypeRef());
    let desc = get_string_attribute(
        element,
        CFString::new("AXDescription").as_concrete_TypeRef(),
    );
    let value = get_string_attribute(element, CFString::new("AXValue").as_concrete_TypeRef());
    let id = get_string_attribute(element, CFString::new("AXIdentifier").as_concrete_TypeRef());
    let value_short = value.as_ref().map(|v| {
        let truncated: String = v.chars().take(60).collect();
        if truncated.len() < v.len() {
            format!("{truncated}…")
        } else {
            truncated
        }
    });
    format!(
        "{label}{{role={role:?} subrole={subrole:?} title={title:?} desc={desc:?} id={id:?} value={value_short:?}}}",
    )
}

/// Get text field information (cursor position, selection length, text content) without screen context.
pub fn get_text_field_info() -> TextFieldInfo {
    catch_unwind(AssertUnwindSafe(|| unsafe { get_text_field_info_impl() })).unwrap_or_else(|_| {
        log::error!("get_text_field_info panicked, returning empty");
        empty_text_field_info()
    })
}

/// Get screen context information gathered from the screen around the focused element.
pub fn get_screen_context() -> ScreenContextInfo {
    catch_unwind(AssertUnwindSafe(|| unsafe { get_screen_context_impl() })).unwrap_or_else(|_| {
        log::error!("get_screen_context panicked, returning empty");
        ScreenContextInfo {
            screen_context: None,
        }
    })
}

unsafe fn get_text_field_info_impl() -> TextFieldInfo {
    let ax_focused_ui_element = CFString::new("AXFocusedUIElement");
    let ax_value = CFString::new("AXValue");
    let ax_selected_text_range = CFString::new("AXSelectedTextRange");

    let system_wide = AXUIElementCreateSystemWide();
    if system_wide.is_null() {
        return empty_text_field_info();
    }

    let mut focused_element: CFTypeRef = ptr::null();
    let result = AXUIElementCopyAttributeValue(
        system_wide,
        ax_focused_ui_element.as_concrete_TypeRef(),
        &mut focused_element,
    );

    CFRelease(system_wide);

    if result != AX_ERROR_SUCCESS || focused_element.is_null() {
        return empty_text_field_info();
    }

    let text_content = get_string_attribute(focused_element, ax_value.as_concrete_TypeRef());

    let (cursor_position, selection_length) = get_range_attribute(
        focused_element,
        ax_selected_text_range.as_concrete_TypeRef(),
    );

    CFRelease(focused_element);

    TextFieldInfo {
        cursor_position,
        selection_length,
        text_content,
    }
}

unsafe fn get_screen_context_impl() -> ScreenContextInfo {
    let ax_focused_ui_element = CFString::new("AXFocusedUIElement");

    let system_wide = AXUIElementCreateSystemWide();
    if system_wide.is_null() {
        return ScreenContextInfo {
            screen_context: None,
        };
    }

    let mut focused_element: CFTypeRef = ptr::null();
    let result = AXUIElementCopyAttributeValue(
        system_wide,
        ax_focused_ui_element.as_concrete_TypeRef(),
        &mut focused_element,
    );

    CFRelease(system_wide);

    if result != AX_ERROR_SUCCESS || focused_element.is_null() {
        return ScreenContextInfo {
            screen_context: None,
        };
    }

    let context = gather_context_outward(focused_element);
    let screen_context = if context.is_empty() {
        None
    } else {
        Some(context)
    };

    CFRelease(focused_element);

    ScreenContextInfo { screen_context }
}

fn empty_text_field_info() -> TextFieldInfo {
    TextFieldInfo {
        cursor_position: None,
        selection_length: None,
        text_content: None,
    }
}

unsafe fn get_string_attribute(element: CFTypeRef, attribute: CFStringRef) -> Option<String> {
    let mut value: CFTypeRef = ptr::null();
    let result = AXUIElementCopyAttributeValue(element, attribute, &mut value);

    if result != AX_ERROR_SUCCESS || value.is_null() {
        return None;
    }

    // Verify the value is actually a CFString before converting
    let value_type_id = CFGetTypeID(value);
    let string_type_id = CFStringGetTypeID();

    if value_type_id != string_type_id {
        CFRelease(value);
        return None;
    }

    // The value is a CFString - convert it
    let cf_string = CFString::wrap_under_get_rule(value as _);
    let string = cf_string.to_string();

    // Release the value we got from Copy
    CFRelease(value);

    Some(string)
}

unsafe fn get_range_attribute(
    element: CFTypeRef,
    attribute: CFStringRef,
) -> (Option<usize>, Option<usize>) {
    let mut value: CFTypeRef = ptr::null();
    let result = AXUIElementCopyAttributeValue(element, attribute, &mut value);

    if result != AX_ERROR_SUCCESS || value.is_null() {
        return (None, None);
    }

    // The value is an AXValue containing a CFRange
    let mut range = CFRange {
        location: 0,
        length: 0,
    };

    if AXValueGetValue(
        value,
        AX_VALUE_TYPE_CF_RANGE,
        &mut range as *mut _ as *mut c_void,
    ) {
        CFRelease(value);

        let cursor = if range.location >= 0 {
            Some(range.location as usize)
        } else {
            None
        };
        let length = if range.length >= 0 {
            Some(range.length as usize)
        } else {
            None
        };

        (cursor, length)
    } else {
        CFRelease(value);
        (None, None)
    }
}

unsafe fn is_element_inside_web_area(focused_element: CFTypeRef) -> bool {
    if focused_element.is_null() {
        return false;
    }

    let ax_parent = CFString::new("AXParent");
    let ax_role = CFString::new("AXRole");
    let mut current_element = focused_element;
    let mut levels_up = 0;

    while levels_up < MAX_LEVELS_UP {
        if let Some(role) = get_string_attribute(current_element, ax_role.as_concrete_TypeRef()) {
            if role == "AXWebArea" {
                if current_element != focused_element {
                    CFRelease(current_element);
                }
                return true;
            }

            if role == "AXWindow" || role == "AXApplication" {
                break;
            }
        }

        let mut parent: CFTypeRef = ptr::null();
        let parent_result = AXUIElementCopyAttributeValue(
            current_element,
            ax_parent.as_concrete_TypeRef(),
            &mut parent,
        );

        if parent_result != AX_ERROR_SUCCESS || parent.is_null() {
            break;
        }

        if current_element != focused_element {
            CFRelease(current_element);
        }

        current_element = parent;
        levels_up += 1;
    }

    if current_element != focused_element {
        CFRelease(current_element);
    }

    false
}

const MAX_CONTEXT_LENGTH: usize = 12000;
const MAX_LEVELS_UP: usize = 20;
const MAX_SIBLINGS: isize = 60;

unsafe fn extract_text_from_element(
    element: CFTypeRef,
    role: &str,
    ax_title: CFStringRef,
    ax_value: CFStringRef,
    ax_description: CFStringRef,
    ax_placeholder: CFStringRef,
) -> Vec<String> {
    let mut texts = Vec::new();

    // Get title (safe for all elements)
    if let Some(title) = get_string_attribute(element, ax_title) {
        let t = title.trim();
        if !t.is_empty() && t.len() < 500 {
            texts.push(t.to_string());
        }
    }

    // Get value for elements that safely support it
    let value_safe_roles = ["AXStaticText", "AXLink", "AXCell", "AXMenuItem"];
    if value_safe_roles.contains(&role) {
        if let Some(value) = get_string_attribute(element, ax_value) {
            let t = value.trim();
            if !t.is_empty() && t.len() < 500 {
                texts.push(t.to_string());
            }
        }
    }

    // Get description (safe for all elements)
    if let Some(desc) = get_string_attribute(element, ax_description) {
        let t = desc.trim();
        if !t.is_empty() && t.len() < 500 {
            texts.push(t.to_string());
        }
    }

    // Get placeholder for text fields
    if role == "AXTextField" || role == "AXTextArea" || role == "AXComboBox" {
        if let Some(ph) = get_string_attribute(element, ax_placeholder) {
            let t = ph.trim();
            if !t.is_empty() {
                texts.push(format!("[placeholder: {}]", t));
            }
        }
    }

    texts
}

#[allow(clippy::too_many_arguments)]
unsafe fn extract_text_from_web_area(
    element: CFTypeRef,
    ax_role: CFStringRef,
    ax_value: CFStringRef,
    ax_children: CFStringRef,
    depth: usize,
    max_depth: usize,
    collected_len: &mut usize,
    max_len: usize,
) -> Vec<String> {
    if element.is_null() || depth > max_depth || *collected_len > max_len {
        return Vec::new();
    }

    let mut texts = Vec::new();

    let role = get_string_attribute(element, ax_role).unwrap_or_default();

    let text_roles = [
        "AXStaticText",
        "AXLink",
        "AXHeading",
        "AXParagraph",
        "AXTextArea",
    ];
    if text_roles.iter().any(|&r| role == r) {
        if let Some(value) = get_string_attribute(element, ax_value) {
            let t = value.trim();
            if !t.is_empty() && t.len() < 1000 {
                *collected_len += t.len();
                texts.push(t.to_string());
            }
        }
    }

    if *collected_len > max_len {
        return texts;
    }

    let mut children_ref: CFTypeRef = ptr::null();
    let result = AXUIElementCopyAttributeValue(element, ax_children, &mut children_ref);
    if result == AX_ERROR_SUCCESS && !children_ref.is_null() {
        let arr = children_ref as core_foundation::array::CFArrayRef;
        let count = CFArrayGetCount(arr).min(100);
        for i in 0..count {
            if *collected_len > max_len {
                break;
            }
            let child = CFArrayGetValueAtIndex(arr, i);
            if !child.is_null() {
                let child_texts = extract_text_from_web_area(
                    child,
                    ax_role,
                    ax_value,
                    ax_children,
                    depth + 1,
                    max_depth,
                    collected_len,
                    max_len,
                );
                texts.extend(child_texts);
            }
        }
        CFRelease(children_ref);
    }

    texts
}

#[allow(clippy::too_many_arguments)]
unsafe fn extract_text_recursive(
    element: CFTypeRef,
    ax_role: CFStringRef,
    ax_title: CFStringRef,
    ax_value: CFStringRef,
    ax_description: CFStringRef,
    ax_placeholder: CFStringRef,
    ax_children: CFStringRef,
    depth: usize,
    max_depth: usize,
) -> Vec<String> {
    if element.is_null() || depth > max_depth {
        return Vec::new();
    }

    let mut texts = Vec::new();

    let role = match get_string_attribute(element, ax_role) {
        Some(r) => r,
        None => return texts,
    };

    // Handle web areas specially (email content, browser content)
    if role == "AXWebArea" {
        let mut collected_len = 0;
        let web_texts = extract_text_from_web_area(
            element,
            ax_role,
            ax_value,
            ax_children,
            0,
            15,
            &mut collected_len,
            8000,
        );
        texts.extend(web_texts);
        return texts;
    }

    // Skip other problematic containers
    if role == "AXScrollArea" || role == "AXUnknown" {
        return texts;
    }

    // Extract text from this element
    let element_texts = extract_text_from_element(
        element,
        &role,
        ax_title,
        ax_value,
        ax_description,
        ax_placeholder,
    );
    texts.extend(element_texts);

    // Recurse into children for container types
    let container_roles = [
        "AXGroup",
        "AXCell",
        "AXRow",
        "AXList",
        "AXTable",
        "AXOutline",
        "AXSection",
        "AXForm",
        "AXArticle",
        "AXLandmarkMain",
        "AXLandmarkNavigation",
        "AXLandmarkSearch",
    ];
    if container_roles.iter().any(|&c| role == c) {
        let mut children_ref: CFTypeRef = ptr::null();
        let result = AXUIElementCopyAttributeValue(element, ax_children, &mut children_ref);
        if result == AX_ERROR_SUCCESS && !children_ref.is_null() {
            let arr = children_ref as core_foundation::array::CFArrayRef;
            let count = CFArrayGetCount(arr).min(30);
            for i in 0..count {
                let child = CFArrayGetValueAtIndex(arr, i);
                if !child.is_null() {
                    let child_texts = extract_text_recursive(
                        child,
                        ax_role,
                        ax_title,
                        ax_value,
                        ax_description,
                        ax_placeholder,
                        ax_children,
                        depth + 1,
                        max_depth,
                    );
                    texts.extend(child_texts);
                }
            }
            CFRelease(children_ref);
        }
    }

    texts
}

unsafe fn gather_context_outward(focused_element: CFTypeRef) -> String {
    if focused_element.is_null() {
        return String::new();
    }

    let mut texts: Vec<String> = Vec::new();

    let ax_parent = CFString::new("AXParent");
    let ax_children = CFString::new("AXChildren");
    let ax_role = CFString::new("AXRole");
    let ax_title = CFString::new("AXTitle");
    let ax_value = CFString::new("AXValue");
    let ax_description = CFString::new("AXDescription");
    let ax_placeholder = CFString::new("AXPlaceholderValue");

    // STEP 1: Get info from the focused element itself
    if let Some(role) = get_string_attribute(focused_element, ax_role.as_concrete_TypeRef()) {
        let focused_texts = extract_text_from_element(
            focused_element,
            &role,
            ax_title.as_concrete_TypeRef(),
            ax_value.as_concrete_TypeRef(),
            ax_description.as_concrete_TypeRef(),
            ax_placeholder.as_concrete_TypeRef(),
        );
        texts.extend(focused_texts);
    }

    // STEP 2: Walk up the hierarchy, collecting text from siblings at each level
    let mut current_element = focused_element;
    let mut levels_up = 0;

    while levels_up < MAX_LEVELS_UP {
        let mut parent: CFTypeRef = ptr::null();
        let parent_result = AXUIElementCopyAttributeValue(
            current_element,
            ax_parent.as_concrete_TypeRef(),
            &mut parent,
        );

        if parent_result != AX_ERROR_SUCCESS || parent.is_null() {
            break;
        }

        let parent_role = get_string_attribute(parent, ax_role.as_concrete_TypeRef());

        // If window/app, get title and stop
        if let Some(ref role) = parent_role {
            if role == "AXWindow" || role == "AXApplication" {
                if let Some(title) = get_string_attribute(parent, ax_title.as_concrete_TypeRef()) {
                    let t = title.trim();
                    if !t.is_empty() {
                        texts.push(format!("[Window: {}]", t));
                    }
                }
                CFRelease(parent);
                break;
            }
        }

        // Get parent's title
        if let Some(title) = get_string_attribute(parent, ax_title.as_concrete_TypeRef()) {
            let t = title.trim();
            if !t.is_empty() && t.len() > 1 {
                texts.push(t.to_string());
            }
        }

        // Get siblings (children of parent)
        let mut children_ref: CFTypeRef = ptr::null();
        let children_result = AXUIElementCopyAttributeValue(
            parent,
            ax_children.as_concrete_TypeRef(),
            &mut children_ref,
        );

        if children_result == AX_ERROR_SUCCESS && !children_ref.is_null() {
            let arr = children_ref as core_foundation::array::CFArrayRef;
            let count = CFArrayGetCount(arr).min(MAX_SIBLINGS);

            for i in 0..count {
                let sibling = CFArrayGetValueAtIndex(arr, i);
                if sibling.is_null() {
                    continue;
                }

                // Extract text recursively (up to 5 levels deep into containers)
                let sibling_texts = extract_text_recursive(
                    sibling,
                    ax_role.as_concrete_TypeRef(),
                    ax_title.as_concrete_TypeRef(),
                    ax_value.as_concrete_TypeRef(),
                    ax_description.as_concrete_TypeRef(),
                    ax_placeholder.as_concrete_TypeRef(),
                    ax_children.as_concrete_TypeRef(),
                    0,
                    5, // max 5 levels deep into each sibling
                );
                texts.extend(sibling_texts);

                // Check length limit
                let current_len: usize = texts.iter().map(|s| s.len()).sum();
                if current_len > MAX_CONTEXT_LENGTH {
                    break;
                }
            }
            CFRelease(children_ref);
        }

        // Check length limit
        let current_len: usize = texts.iter().map(|s| s.len()).sum();
        if current_len > MAX_CONTEXT_LENGTH {
            CFRelease(parent);
            break;
        }

        // Move up
        if levels_up > 0 && current_element != focused_element {
            CFRelease(current_element);
        }
        current_element = parent;
        levels_up += 1;
    }

    // Cleanup
    if levels_up > 0 && current_element != focused_element {
        CFRelease(current_element);
    }

    // Deduplicate while preserving order
    let mut seen = std::collections::HashSet::new();
    let unique_texts: Vec<String> = texts
        .into_iter()
        .filter(|s| seen.insert(s.clone()))
        .collect();

    unique_texts.join("\n")
}

// Legacy function - kept for reference
#[allow(dead_code)]
const MAX_CONTEXT_DEPTH: usize = 10;
#[allow(dead_code)]
const MAX_CHILDREN_TO_TRAVERSE: isize = 100;

#[allow(dead_code)]
unsafe fn gather_screen_context(element: CFTypeRef, depth: usize) -> String {
    // Conservative limits to avoid crashes with problematic elements
    const SAFE_MAX_DEPTH: usize = 3;
    const SAFE_MAX_CHILDREN: isize = 30;
    const SAFE_MAX_TEXTS: usize = 100;

    if element.is_null() || depth > SAFE_MAX_DEPTH {
        return String::new();
    }

    let mut texts: Vec<String> = Vec::new();

    let ax_role = CFString::new("AXRole");
    let ax_title = CFString::new("AXTitle");
    let ax_value = CFString::new("AXValue");
    let ax_children = CFString::new("AXChildren");

    // First check if we can access this element's role - if not, skip entirely
    let mut role_ref: CFTypeRef = ptr::null();
    let role_result =
        AXUIElementCopyAttributeValue(element, ax_role.as_concrete_TypeRef(), &mut role_ref);

    // If we can't get the role, this element doesn't support accessibility properly
    if role_result != AX_ERROR_SUCCESS {
        return String::new();
    }

    let role = if !role_ref.is_null() {
        let cf_string = CFString::wrap_under_get_rule(role_ref as _);
        let s = cf_string.to_string();
        CFRelease(role_ref);
        Some(s)
    } else {
        None
    };

    // Skip certain roles that are known to be problematic or not useful
    if let Some(ref r) = role {
        let skip_roles = [
            "AXWebArea",    // Web content can be huge and problematic
            "AXScrollArea", // Just a container
            "AXSplitGroup", // Just a container
            "AXLayoutArea", // Just a container
            "AXUnknown",    // Unknown elements
        ];
        if skip_roles.iter().any(|&sr| r == sr) {
            return String::new();
        }
    }

    // Extract text from text-bearing elements
    if let Some(ref r) = role {
        let text_roles = [
            "AXStaticText",
            "AXTextField",
            "AXTextArea",
            "AXButton",
            "AXLink",
            "AXHeading",
            "AXCell",
            "AXMenuItem",
            "AXMenuButton",
            "AXPopUpButton",
            "AXComboBox",
            "AXGroup",  // Groups often have titles
            "AXWindow", // Window title
        ];

        if text_roles.iter().any(|&tr| r == tr) {
            // Get title
            if let Some(title) = get_string_attribute(element, ax_title.as_concrete_TypeRef()) {
                let trimmed = title.trim();
                if !trimmed.is_empty() && trimmed.len() > 1 {
                    texts.push(trimmed.to_string());
                }
            }

            // Get value (for text fields, but skip if it's too long - probably the focused field)
            if let Some(value) = get_string_attribute(element, ax_value.as_concrete_TypeRef()) {
                let trimmed = value.trim();
                if !trimmed.is_empty() && trimmed.len() > 1 && trimmed.len() < 500 {
                    texts.push(trimmed.to_string());
                }
            }
        }
    }

    // Get children and recurse (only if we haven't gathered too much yet)
    if texts.len() < SAFE_MAX_TEXTS {
        let mut children_ref: CFTypeRef = ptr::null();
        let children_result = AXUIElementCopyAttributeValue(
            element,
            ax_children.as_concrete_TypeRef(),
            &mut children_ref,
        );

        if children_result == AX_ERROR_SUCCESS && !children_ref.is_null() {
            let children_array = children_ref as core_foundation::array::CFArrayRef;
            let count = CFArrayGetCount(children_array).min(SAFE_MAX_CHILDREN);

            for i in 0..count {
                let child = CFArrayGetValueAtIndex(children_array, i);
                if !child.is_null() {
                    let child_text = gather_screen_context(child, depth + 1);
                    if !child_text.is_empty() {
                        texts.push(child_text);
                    }
                }

                // Stop if we have enough
                let current_len: usize = texts.iter().map(|s| s.len()).sum();
                if current_len > MAX_CONTEXT_LENGTH || texts.len() >= SAFE_MAX_TEXTS {
                    break;
                }
            }
            CFRelease(children_ref);
        }
    }

    texts.join("\n")
}

pub fn insert_text_at_cursor(text: &str) -> Result<(), String> {
    let text = text.to_string();
    run_on_main_thread(move || {
        catch_unwind(AssertUnwindSafe(move || unsafe {
            insert_text_at_cursor_impl(&text)
        }))
        .unwrap_or_else(|_| Err("accessibility insert panicked".to_string()))
    })
}

unsafe fn insert_text_at_cursor_impl(text: &str) -> Result<(), String> {
    let ax_focused_ui_element = CFString::new("AXFocusedUIElement");
    let ax_selected_text = CFString::new("AXSelectedText");
    let ax_value = CFString::new("AXValue");

    let system_wide = AXUIElementCreateSystemWide();
    if system_wide.is_null() {
        return Err("failed to get system-wide AX element".to_string());
    }

    let mut focused_element: CFTypeRef = ptr::null();
    let result = AXUIElementCopyAttributeValue(
        system_wide,
        ax_focused_ui_element.as_concrete_TypeRef(),
        &mut focused_element,
    );

    CFRelease(system_wide);

    if result != AX_ERROR_SUCCESS || focused_element.is_null() {
        return Err("no focused element".to_string());
    }

    if is_element_inside_web_area(focused_element) {
        CFRelease(focused_element);
        return Err("focused element is inside AXWebArea".to_string());
    }

    // Check if the focused element actually supports setting AXSelectedText
    let mut settable = false;
    let settable_result = AXUIElementIsAttributeSettable(
        focused_element,
        ax_selected_text.as_concrete_TypeRef(),
        &mut settable,
    );

    if settable_result != AX_ERROR_SUCCESS || !settable {
        CFRelease(focused_element);
        return Err("AXSelectedText is not settable on focused element".to_string());
    }

    // Snapshot the field value before inserting so we can verify
    let value_before = get_string_attribute(focused_element, ax_value.as_concrete_TypeRef());

    let cf_text = CFString::new(text);
    let set_result = AXUIElementSetAttributeValue(
        focused_element,
        ax_selected_text.as_concrete_TypeRef(),
        cf_text.as_CFTypeRef(),
    );

    if set_result != AX_ERROR_SUCCESS {
        CFRelease(focused_element);
        return Err(format!("AXUIElementSetAttributeValue failed: {set_result}"));
    }

    // Verify: if we can read the value and it didn't change, the insert silently failed
    let value_after = get_string_attribute(focused_element, ax_value.as_concrete_TypeRef());
    CFRelease(focused_element);

    if let (Some(before), Some(after)) = (&value_before, &value_after) {
        if before == after {
            return Err("AXSelectedText accepted but field value unchanged".to_string());
        }
    }

    Ok(())
}

pub fn check_focused_paste_target() -> crate::commands::PasteTargetState {
    use crate::commands::PasteTargetState;
    catch_unwind(AssertUnwindSafe(|| unsafe {
        check_focused_paste_target_impl()
    }))
    .unwrap_or(PasteTargetState::Unknown)
}

unsafe fn check_focused_paste_target_impl() -> crate::commands::PasteTargetState {
    use crate::commands::PasteTargetState;

    let ax_focused_ui_element = CFString::new("AXFocusedUIElement");
    let ax_role = CFString::new("AXRole");
    let ax_value = CFString::new("AXValue");
    let ax_selected_text = CFString::new("AXSelectedText");

    let system_wide = AXUIElementCreateSystemWide();
    if system_wide.is_null() {
        return PasteTargetState::Unknown;
    }

    let mut focused: CFTypeRef = ptr::null();
    let result = AXUIElementCopyAttributeValue(
        system_wide,
        ax_focused_ui_element.as_concrete_TypeRef(),
        &mut focused,
    );
    CFRelease(system_wide);

    if result != AX_ERROR_SUCCESS {
        return PasteTargetState::Unknown;
    }
    if focused.is_null() {
        return PasteTargetState::NotEditable;
    }

    let role = get_string_attribute(focused, ax_role.as_concrete_TypeRef());

    let editable_roles = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"];
    if let Some(ref r) = role {
        if editable_roles.iter().any(|er| er == r) {
            CFRelease(focused);
            return PasteTargetState::Editable;
        }
    }

    if is_element_inside_web_area(focused) {
        CFRelease(focused);
        return PasteTargetState::Unknown;
    }

    let mut settable = false;
    let settable_result = AXUIElementIsAttributeSettable(
        focused,
        ax_selected_text.as_concrete_TypeRef(),
        &mut settable,
    );
    if settable_result == AX_ERROR_SUCCESS && settable {
        CFRelease(focused);
        return PasteTargetState::Editable;
    }

    settable = false;
    let value_settable_result =
        AXUIElementIsAttributeSettable(focused, ax_value.as_concrete_TypeRef(), &mut settable);
    CFRelease(focused);

    if value_settable_result == AX_ERROR_SUCCESS && settable {
        return PasteTargetState::Editable;
    }

    PasteTargetState::NotEditable
}

pub fn get_selected_text() -> Option<String> {
    use std::{thread, time::Duration};

    // Wait for hotkey modifier keys to physically release before simulating Cmd+C
    thread::sleep(Duration::from_millis(50));

    let mut clipboard = arboard::Clipboard::new().ok()?;
    let previous = crate::platform::SavedClipboard::save(&mut clipboard);
    clipboard.clear().ok();

    super::input::simulate_cmd_c().ok()?;
    thread::sleep(Duration::from_millis(100));

    let selected = clipboard.get_text().ok();

    thread::spawn(move || {
        thread::sleep(Duration::from_millis(100));
        previous.restore();
    });

    selected.filter(|s| !s.is_empty())
}

const DUMP_MAX_DEPTH: usize = 30;
const DUMP_MAX_ELEMENTS: usize = 5000;
const DUMP_MAX_VALUE_CHARS: usize = 80;

pub fn gather_accessibility_dump() -> crate::commands::AccessibilityDumpResult {
    catch_unwind(AssertUnwindSafe(|| unsafe {
        gather_accessibility_dump_impl()
    }))
    .unwrap_or_else(|_| {
        log::error!("gather_accessibility_dump panicked");
        empty_dump_result()
    })
}

fn empty_dump_result() -> crate::commands::AccessibilityDumpResult {
    crate::commands::AccessibilityDumpResult {
        dump: None,
        window_title: None,
        process_name: None,
        element_count: 0,
    }
}

unsafe fn gather_accessibility_dump_impl() -> crate::commands::AccessibilityDumpResult {
    let system_wide = AXUIElementCreateSystemWide();
    if system_wide.is_null() {
        return empty_dump_result();
    }

    let ax_focused_app = CFString::new("AXFocusedApplication");
    let mut focused_app: CFTypeRef = ptr::null();
    let app_result = AXUIElementCopyAttributeValue(
        system_wide,
        ax_focused_app.as_concrete_TypeRef(),
        &mut focused_app,
    );
    CFRelease(system_wide);

    if app_result != AX_ERROR_SUCCESS || focused_app.is_null() {
        log::warn!("gather_accessibility_dump: no focused application");
        return empty_dump_result();
    }

    let mut pid: i32 = 0;
    let pid_ok = AXUIElementGetPid(focused_app as AXUIElementRef, &mut pid) == AX_ERROR_SUCCESS;
    let process_name = if pid_ok && pid > 0 {
        process_name_for_pid(pid)
    } else {
        None
    };

    let app_title =
        get_string_attribute(focused_app, CFString::new("AXTitle").as_concrete_TypeRef());

    let ax_focused_window = CFString::new("AXFocusedWindow");
    let mut focused_window: CFTypeRef = ptr::null();
    let win_result = AXUIElementCopyAttributeValue(
        focused_app,
        ax_focused_window.as_concrete_TypeRef(),
        &mut focused_window,
    );

    let window_title = if win_result == AX_ERROR_SUCCESS && !focused_window.is_null() {
        get_string_attribute(
            focused_window,
            CFString::new("AXTitle").as_concrete_TypeRef(),
        )
    } else {
        None
    };

    let mut lines: Vec<String> = Vec::new();
    let mut element_count: usize = 0;

    let mut header = format!("[App] {:?}", app_title.as_deref().unwrap_or(""));
    if pid_ok && pid > 0 {
        header.push_str(&format!(" (pid={pid})"));
    }
    if let Some(ref name) = process_name {
        header.push_str(&format!(" process={name:?}"));
    }
    lines.push(header);
    element_count += 1;

    if win_result == AX_ERROR_SUCCESS && !focused_window.is_null() {
        lines.push(format!(
            "  [Window] {:?}",
            window_title.as_deref().unwrap_or(""),
        ));
        element_count += 1;
        dump_element_children(focused_window, 2, &mut lines, &mut element_count);
        CFRelease(focused_window);
    } else {
        log::info!(
            "gather_accessibility_dump: no AXFocusedWindow on app, dumping app element instead"
        );
        dump_element_children(focused_app, 1, &mut lines, &mut element_count);
    }

    CFRelease(focused_app);

    let dump = if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
    };

    crate::commands::AccessibilityDumpResult {
        dump,
        window_title,
        process_name,
        element_count,
    }
}

unsafe fn dump_element_children(
    parent: CFTypeRef,
    depth: usize,
    lines: &mut Vec<String>,
    element_count: &mut usize,
) {
    if depth > DUMP_MAX_DEPTH || *element_count >= DUMP_MAX_ELEMENTS {
        return;
    }

    let ax_children = CFString::new("AXChildren");
    let mut children_ref: CFTypeRef = ptr::null();
    let result =
        AXUIElementCopyAttributeValue(parent, ax_children.as_concrete_TypeRef(), &mut children_ref);
    if result != AX_ERROR_SUCCESS || children_ref.is_null() {
        return;
    }

    let arr = children_ref as core_foundation::array::CFArrayRef;
    let count = CFArrayGetCount(arr) as usize;

    for i in 0..count {
        if *element_count >= DUMP_MAX_ELEMENTS {
            lines.push(format!(
                "{}... (truncated at {} elements)",
                "  ".repeat(depth),
                DUMP_MAX_ELEMENTS,
            ));
            break;
        }
        let child = CFArrayGetValueAtIndex(arr, i as isize);
        if child.is_null() {
            continue;
        }
        lines.push(format_element_line(child, depth, i));
        *element_count += 1;

        if depth < DUMP_MAX_DEPTH {
            dump_element_children(child, depth + 1, lines, element_count);
        }
    }

    CFRelease(children_ref);
}

unsafe fn format_element_line(element: CFTypeRef, depth: usize, child_index: usize) -> String {
    let indent = "  ".repeat(depth);
    let role = get_string_attribute(element, CFString::new("AXRole").as_concrete_TypeRef())
        .unwrap_or_else(|| "<no role>".to_string());
    let mut s = format!("{indent}[{child_index}] {role}");

    if let Some(sr) =
        get_string_attribute(element, CFString::new("AXSubrole").as_concrete_TypeRef())
    {
        if !sr.is_empty() {
            s.push_str(&format!(" ({sr})"));
        }
    }
    if let Some(t) = get_string_attribute(element, CFString::new("AXTitle").as_concrete_TypeRef())
        .filter(|t| !t.is_empty())
    {
        s.push_str(&format!(" title={:?}", truncate_for_dump(&t)));
    }
    if let Some(d) = get_string_attribute(
        element,
        CFString::new("AXDescription").as_concrete_TypeRef(),
    )
    .filter(|d| !d.is_empty())
    {
        s.push_str(&format!(" desc={:?}", truncate_for_dump(&d)));
    }
    if let Some(v) = get_string_attribute(element, CFString::new("AXValue").as_concrete_TypeRef())
        .filter(|v| !v.is_empty())
    {
        s.push_str(&format!(" value={:?}", truncate_for_dump(&v)));
    }
    if let Some(id) =
        get_string_attribute(element, CFString::new("AXIdentifier").as_concrete_TypeRef())
            .filter(|i| !i.is_empty())
    {
        s.push_str(&format!(" id={:?}", truncate_for_dump(&id)));
    }
    s
}

fn truncate_for_dump(s: &str) -> String {
    let cleaned: String = s.replace('\n', "\\n").replace('\r', "\\r");
    let truncated: String = cleaned.chars().take(DUMP_MAX_VALUE_CHARS).collect();
    if truncated.len() < cleaned.len() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

fn process_name_for_pid(pid: i32) -> Option<String> {
    use cocoa::base::{id, nil};
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;
    use std::os::raw::c_char;

    catch_unwind(AssertUnwindSafe(|| unsafe {
        let pool: id = msg_send![class!(NSAutoreleasePool), new];
        let app: id = msg_send![
            class!(NSRunningApplication),
            runningApplicationWithProcessIdentifier: pid
        ];
        if app == nil {
            let _: () = msg_send![pool, drain];
            return None;
        }
        let name_ns: id = msg_send![app, localizedName];
        let name = if name_ns == nil {
            None
        } else {
            let utf8: *const c_char = msg_send![name_ns, UTF8String];
            if utf8.is_null() {
                None
            } else {
                Some(CStr::from_ptr(utf8).to_string_lossy().into_owned())
            }
        };
        let _: () = msg_send![pool, drain];
        name
    }))
    .ok()
    .flatten()
}

/// Top-down DFS from `parent` looking for `target`. Returns the index path
/// (relative to `parent`) and the fingerprint chain. Used at bind time so
/// the captured path is built via AXChildren walks — same direction the
/// resolver walks at sync time. Avoids relying on AXParent, which Java's
/// CAccessible bridge reports inconsistently with AXChildren.
unsafe fn find_path_to_element(
    parent: CFTypeRef,
    target: CFTypeRef,
    max_depth: usize,
) -> Option<(Vec<usize>, Vec<crate::commands::ElementFingerprint>)> {
    if max_depth == 0 {
        return None;
    }
    let ax_children = CFString::new("AXChildren");
    let mut children_ref: CFTypeRef = ptr::null();
    let r =
        AXUIElementCopyAttributeValue(parent, ax_children.as_concrete_TypeRef(), &mut children_ref);
    if r != AX_ERROR_SUCCESS || children_ref.is_null() {
        return None;
    }
    let arr = children_ref as core_foundation::array::CFArrayRef;
    let count = CFArrayGetCount(arr) as usize;

    for i in 0..count {
        let child = CFArrayGetValueAtIndex(arr, i as isize);
        if child.is_null() {
            continue;
        }
        let is_target = child == target || core_foundation::base::CFEqual(child, target) != 0;

        if is_target {
            let fp = capture_macos_fingerprint(child, i);
            CFRelease(children_ref);
            return Some((vec![i], vec![fp]));
        }

        if let Some((mut sub_path, mut sub_chain)) =
            find_path_to_element(child, target, max_depth - 1)
        {
            let fp = capture_macos_fingerprint(child, i);
            sub_path.insert(0, i);
            sub_chain.insert(0, fp);
            CFRelease(children_ref);
            return Some((sub_path, sub_chain));
        }
    }
    CFRelease(children_ref);
    None
}

/// True when an AX role names a text-input widget the user might bind. We
/// check this before trusting AXFocusedUIElement, because Java Swing's
/// CAccessible reports a structural container as the focused element while
/// the actual editable widget sits one level below.
fn is_text_role(role: Option<&str>) -> bool {
    matches!(
        role,
        Some("AXTextField" | "AXTextArea" | "AXSecureTextField" | "AXComboBox")
    )
}

/// Look up the AX element directly under the mouse cursor in screen-space
/// coordinates. Used as a fallback when the focused element isn't trustworthy
/// (Java apps, mostly). Caller owns the returned reference.
unsafe fn element_under_cursor(system_wide: CFTypeRef) -> Option<CFTypeRef> {
    let event = CGEventCreate(ptr::null());
    if event.is_null() {
        return None;
    }
    let cursor = CGEventGetLocation(event);
    CFRelease(event);

    let mut at_cursor: CFTypeRef = ptr::null();
    let r = AXUIElementCopyElementAtPosition(
        system_wide,
        cursor.x as f32,
        cursor.y as f32,
        &mut at_cursor,
    );
    if r != AX_ERROR_SUCCESS || at_cursor.is_null() {
        return None;
    }
    Some(at_cursor)
}

pub fn get_focused_field_info() -> Option<crate::commands::AccessibilityFieldInfo> {
    catch_unwind(AssertUnwindSafe(|| unsafe {
        get_focused_field_info_impl()
    }))
    .unwrap_or_else(|_| {
        log::error!("get_focused_field_info panicked, returning None");
        None
    })
}

unsafe fn get_focused_field_info_impl() -> Option<crate::commands::AccessibilityFieldInfo> {
    debug_log("\n=== BIND: get_focused_field_info ===");

    let ax_focused_ui_element = CFString::new("AXFocusedUIElement");
    let ax_role = CFString::new("AXRole");
    let ax_title = CFString::new("AXTitle");
    let ax_description = CFString::new("AXDescription");
    let ax_value = CFString::new("AXValue");
    let ax_placeholder = CFString::new("AXPlaceholderValue");
    let ax_parent = CFString::new("AXParent");

    let system_wide = AXUIElementCreateSystemWide();
    if system_wide.is_null() {
        debug_log("BIND: AXUIElementCreateSystemWide returned null");
        return None;
    }

    let mut focused_element: CFTypeRef = ptr::null();
    let result = AXUIElementCopyAttributeValue(
        system_wide,
        ax_focused_ui_element.as_concrete_TypeRef(),
        &mut focused_element,
    );

    if result != AX_ERROR_SUCCESS || focused_element.is_null() {
        debug_log(&format!(
            "BIND: AXFocusedUIElement read failed (result={result}, null={})",
            focused_element.is_null()
        ));
        CFRelease(system_wide);
        return None;
    }

    debug_log(&snapshot_element(
        "BIND: AXFocusedUIElement = ",
        focused_element,
    ));

    // Java's CAccessible bridge often returns a structural container as the
    // "focused" element instead of the actual JTextPane the user clicked.
    // When the focused element has no real role (or a non-text container
    // role), prefer whatever element is under the mouse cursor — the user
    // just clicked there, so it's the field they meant to bind.
    let focused_role_check = get_string_attribute(focused_element, ax_role.as_concrete_TypeRef());
    debug_log(&format!(
        "BIND: focused role text-y? {} (role={:?})",
        is_text_role(focused_role_check.as_deref()),
        focused_role_check
    ));
    if !is_text_role(focused_role_check.as_deref()) {
        let event = CGEventCreate(ptr::null());
        if !event.is_null() {
            let cursor = CGEventGetLocation(event);
            CFRelease(event);
            debug_log(&format!(
                "BIND: cursor at ({:.1}, {:.1})",
                cursor.x, cursor.y
            ));
        }
        if let Some(at_cursor) = element_under_cursor(system_wide) {
            debug_log(&snapshot_element("BIND: cursor element = ", at_cursor));
            let cursor_role = get_string_attribute(at_cursor, ax_role.as_concrete_TypeRef());
            if is_text_role(cursor_role.as_deref()) {
                debug_log(&format!(
                    "BIND: switching to cursor element (role={cursor_role:?})"
                ));
                CFRelease(focused_element);
                focused_element = at_cursor;
            } else {
                debug_log(&format!(
                    "BIND: cursor element role={cursor_role:?} also not text-y; keeping focused"
                ));
                CFRelease(at_cursor);
            }
        } else {
            debug_log("BIND: no element found under cursor");
        }
    }
    CFRelease(system_wide);

    debug_log(&snapshot_element("BIND: final target = ", focused_element));

    let role = get_string_attribute(focused_element, ax_role.as_concrete_TypeRef());
    let title = get_string_attribute(focused_element, ax_title.as_concrete_TypeRef());
    let description = get_string_attribute(focused_element, ax_description.as_concrete_TypeRef());
    let value = get_string_attribute(focused_element, ax_value.as_concrete_TypeRef());
    let placeholder = get_string_attribute(focused_element, ax_placeholder.as_concrete_TypeRef());

    let mut is_settable = false;
    AXUIElementIsAttributeSettable(
        focused_element,
        ax_value.as_concrete_TypeRef(),
        &mut is_settable,
    );

    let mut app_pid: Option<i32> = None;
    let mut pid: i32 = 0;
    if AXUIElementGetPid(focused_element as AXUIElementRef, &mut pid) == AX_ERROR_SUCCESS {
        app_pid = Some(pid);
    }

    let mut app_name: Option<String> = None;
    let mut window_title: Option<String> = None;

    // Walk up via AXParent ONLY to capture window_title and app_name. We do
    // NOT use the indices from this walk: Java's CAccessible has broken
    // parent↔child links — AXParent of an inner element can skip nodes that
    // AXChildren legitimately includes, so the upward indices don't agree
    // with downward ones. Path construction happens via top-down DFS below.
    {
        let mut current = focused_element;
        let mut levels = 0;
        while levels < MAX_LEVELS_UP {
            let mut parent: CFTypeRef = ptr::null();
            let r = AXUIElementCopyAttributeValue(
                current,
                ax_parent.as_concrete_TypeRef(),
                &mut parent,
            );
            if r != AX_ERROR_SUCCESS || parent.is_null() {
                break;
            }
            let parent_role = get_string_attribute(parent, ax_role.as_concrete_TypeRef());
            debug_log(&format!(
                "BIND: parent walk depth {levels}: role={parent_role:?}"
            ));
            let mut should_break = false;
            match parent_role.as_deref() {
                Some("AXWindow") if window_title.is_none() => {
                    window_title = get_string_attribute(parent, ax_title.as_concrete_TypeRef());
                }
                Some("AXApplication") => {
                    app_name = get_string_attribute(parent, ax_title.as_concrete_TypeRef());
                    should_break = true;
                }
                _ => {}
            }
            // Release `current` before reassigning. Skip release for the
            // sentinel `focused_element` reference — its lifetime is
            // managed at the end of the function.
            if current != focused_element {
                CFRelease(current);
            }
            if should_break {
                CFRelease(parent);
                current = focused_element;
                break;
            }
            current = parent;
            levels += 1;
        }
        if current != focused_element {
            CFRelease(current);
        }
    }

    // Build the index path by walking DOWN from the AXApplication root.
    // AXChildren is the source of truth at sync time too, so the path we
    // record matches the path the resolver walks.
    let mut element_index_path: Vec<usize> = Vec::new();
    let mut fingerprint_chain: Vec<crate::commands::ElementFingerprint> = Vec::new();
    if let Some(p) = app_pid {
        let app_root = AXUIElementCreateApplication(p);
        if !app_root.is_null() {
            debug_log("BIND: top-down DFS from AXApplication root...");
            match find_path_to_element(app_root, focused_element, MAX_LEVELS_UP) {
                Some((path, chain)) => {
                    debug_log(&format!(
                        "BIND: DFS found path={path:?} after visiting {} levels",
                        chain.len()
                    ));
                    element_index_path = path;
                    fingerprint_chain = chain;
                }
                None => {
                    debug_log("BIND: DFS could NOT find focused element under AXApplication root");
                }
            }
            CFRelease(app_root);
        } else {
            debug_log("BIND: AXUIElementCreateApplication returned null");
        }
    } else {
        debug_log("BIND: no app_pid; cannot build path via DFS");
    }

    debug_log(&format!(
        "BIND: captured pid={app_pid:?} path={element_index_path:?} chain={}",
        chain_summary(&fingerprint_chain)
    ));

    CFRelease(focused_element);

    let app_identity = app_pid.and_then(capture_app_identity);

    Some(crate::commands::AccessibilityFieldInfo {
        role,
        title,
        description,
        value,
        placeholder,
        app_pid,
        app_name,
        window_title,
        is_settable,
        element_index_path,
        fingerprint_chain,
        can_paste: false,
        backend: None,
        jab_string_path: vec![],
        app_identity,
        details: None,
    })
}

/// Snapshot the identifying attributes of a macOS AX element. Captured at
/// bind time and used at sync time to verify we land on the same element
/// even when the AX tree shifts (Java Swing in particular reorders/inserts
/// helper nodes between bind and sync).
unsafe fn capture_macos_fingerprint(
    element: CFTypeRef,
    child_index: usize,
) -> crate::commands::ElementFingerprint {
    let role = get_string_attribute(element, CFString::new("AXRole").as_concrete_TypeRef());
    let subrole = get_string_attribute(element, CFString::new("AXSubrole").as_concrete_TypeRef());
    let title = get_string_attribute(element, CFString::new("AXTitle").as_concrete_TypeRef());
    let description = get_string_attribute(
        element,
        CFString::new("AXDescription").as_concrete_TypeRef(),
    );
    let identifier =
        get_string_attribute(element, CFString::new("AXIdentifier").as_concrete_TypeRef());

    crate::commands::ElementFingerprint {
        automation_id: None,
        class_name: None,
        control_type: 0,
        name: None,
        framework_id: None,
        child_index,
        ax_role: role,
        ax_subrole: subrole,
        ax_title: title,
        ax_description: description,
        ax_identifier: identifier,
        details: None,
    }
}

/// Score how well `element` matches `fp`. Returns 0 when the element is
/// definitely the wrong one (mismatched role or identifier); otherwise
/// returns a positive score weighted by how many attributes agree.
unsafe fn fingerprint_score(
    element: CFTypeRef,
    fp: &crate::commands::ElementFingerprint,
    actual_index: usize,
) -> u32 {
    let mut score: u32 = 0;

    if let Some(ref expected) = fp.ax_identifier {
        match get_string_attribute(element, CFString::new("AXIdentifier").as_concrete_TypeRef()) {
            Some(a) if &a == expected => score += 200,
            Some(_) => return 0,
            None => {}
        }
    }

    if let Some(ref expected) = fp.ax_role {
        match get_string_attribute(element, CFString::new("AXRole").as_concrete_TypeRef()) {
            Some(a) if &a == expected => score += 50,
            _ => return 0,
        }
    }

    if let Some(ref expected) = fp.ax_subrole {
        if let Some(a) =
            get_string_attribute(element, CFString::new("AXSubrole").as_concrete_TypeRef())
        {
            if &a == expected {
                score += 30;
            }
        }
    }

    if let Some(ref expected) = fp.ax_title {
        if let Some(a) =
            get_string_attribute(element, CFString::new("AXTitle").as_concrete_TypeRef())
        {
            if &a == expected {
                score += 40;
            }
        }
    }

    if let Some(ref expected) = fp.ax_description {
        if let Some(a) = get_string_attribute(
            element,
            CFString::new("AXDescription").as_concrete_TypeRef(),
        ) {
            if &a == expected {
                score += 20;
            }
        }
    }

    if actual_index == fp.child_index {
        score += 5;
    }

    // Legacy bindings have no fingerprint signal at all — accept by index.
    if score == 0 {
        let any_signal = fp.ax_identifier.is_some()
            || fp.ax_role.is_some()
            || fp.ax_subrole.is_some()
            || fp.ax_title.is_some()
            || fp.ax_description.is_some();
        if !any_signal {
            return 1;
        }
    }

    score
}

pub fn focus_accessibility_field(
    app_pid: i32,
    element_index_path: &[usize],
    fingerprint_chain: Option<&[crate::commands::ElementFingerprint]>,
    _backend: Option<&str>,
    _jab_string_path: Option<&[crate::commands::JabElementId]>,
) -> Result<(), String> {
    let chain = fingerprint_chain.map(|c| c.to_vec());
    catch_unwind(AssertUnwindSafe(|| unsafe {
        focus_accessibility_field_impl(app_pid, element_index_path, chain.as_deref())
    }))
    .unwrap_or_else(|_| {
        log::error!("focus_accessibility_field panicked");
        Err("focus_accessibility_field panicked".to_string())
    })
}

unsafe fn focus_accessibility_field_impl(
    app_pid: i32,
    element_index_path: &[usize],
    fingerprint_chain: Option<&[crate::commands::ElementFingerprint]>,
) -> Result<(), String> {
    let ax_focused = CFString::new("AXFocused");
    let ax_value = CFString::new("AXValue");
    let ax_selected_text_range = CFString::new("AXSelectedTextRange");

    let app_element = AXUIElementCreateApplication(app_pid);
    if app_element.is_null() {
        return Err("Failed to create app element".to_string());
    }

    let raise_attr = CFString::new("AXFrontmost");
    let cf_true = core_foundation::boolean::CFBoolean::true_value();
    AXUIElementSetAttributeValue(
        app_element,
        raise_attr.as_concrete_TypeRef(),
        cf_true.as_CFTypeRef(),
    );
    CFRelease(app_element);

    let element = resolve_element(app_pid, element_index_path, fingerprint_chain)
        .map_err(|err| format!("Could not resolve element by path: {err}"))?;

    let cf_true = core_foundation::boolean::CFBoolean::true_value();
    let focus_result = AXUIElementSetAttributeValue(
        element,
        ax_focused.as_concrete_TypeRef(),
        cf_true.as_CFTypeRef(),
    );
    if focus_result != AX_ERROR_SUCCESS {
        CFRelease(element);
        return Err(format!(
            "Failed to focus element: AX error {}",
            focus_result
        ));
    }

    let text_len = get_string_attribute(element, ax_value.as_concrete_TypeRef())
        .map(|s| s.len())
        .unwrap_or(0);

    if text_len > 0 {
        let position = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos() as usize)
            % (text_len + 1);

        let range = CFRange {
            location: position as isize,
            length: 0,
        };
        let range_value =
            AXValueCreate(AX_VALUE_TYPE_CF_RANGE, &range as *const _ as *const c_void);
        if !range_value.is_null() {
            AXUIElementSetAttributeValue(
                element,
                ax_selected_text_range.as_concrete_TypeRef(),
                range_value,
            );
            CFRelease(range_value);
        }
    }

    CFRelease(element);
    Ok(())
}

pub fn write_accessibility_fields(
    entries: Vec<crate::commands::AccessibilityWriteEntry>,
) -> crate::commands::AccessibilityWriteResult {
    catch_unwind(AssertUnwindSafe(|| unsafe {
        write_accessibility_fields_impl(entries)
    }))
    .unwrap_or_else(|_| {
        log::error!("write_accessibility_fields panicked");
        crate::commands::AccessibilityWriteResult {
            succeeded: 0,
            failed: 0,
            errors: vec!["write_accessibility_fields panicked".to_string()],
        }
    })
}

/// Resolve an element by walking the index path from the application root,
/// using `fingerprint_chain` (when present) to verify each level and to
/// recover when the recorded index now points at a different element. The
/// AX tree shifts in Java Swing apps between bind and sync; without a
/// fingerprint check we'd silently land on the wrong field.
///
/// `fingerprint_chain[i]` describes the element at `index_path[..=i]` —
/// they're built in the same order at bind time.
unsafe fn resolve_element(
    app_pid: i32,
    index_path: &[usize],
    fingerprint_chain: Option<&[crate::commands::ElementFingerprint]>,
) -> Result<CFTypeRef, String> {
    debug_log(&format!(
        "RESOLVE: pid={app_pid} path={index_path:?} chain={}",
        chain_summary(fingerprint_chain.unwrap_or(&[]))
    ));

    let app_element = AXUIElementCreateApplication(app_pid);
    if app_element.is_null() {
        debug_log("RESOLVE: AXUIElementCreateApplication returned null");
        return Err("could not create application AX element".to_string());
    }

    let ax_children = CFString::new("AXChildren");
    let mut current = app_element;

    for (depth, &recorded_index) in index_path.iter().enumerate() {
        let fp = fingerprint_chain.and_then(|c| c.get(depth));

        let mut children_ref: CFTypeRef = ptr::null();
        let result = AXUIElementCopyAttributeValue(
            current,
            ax_children.as_concrete_TypeRef(),
            &mut children_ref,
        );
        if result != AX_ERROR_SUCCESS || children_ref.is_null() {
            if current != app_element {
                CFRelease(current);
            }
            CFRelease(app_element);
            return Err(format!(
                "depth {depth}: AXChildren read failed (AX error {result})"
            ));
        }

        let arr = children_ref as core_foundation::array::CFArrayRef;
        let count = CFArrayGetCount(arr) as usize;
        debug_log(&format!(
            "RESOLVE: depth {depth}: {count} children, recorded_index={recorded_index}"
        ));

        let mut chosen: Option<usize> = None;
        let mut chosen_score: u32 = 0;

        // Fast path: try the recorded index first, accept it if there's
        // either no fingerprint to check or the fingerprint scores > 0.
        if recorded_index < count {
            let candidate = CFArrayGetValueAtIndex(arr, recorded_index as isize);
            if !candidate.is_null() {
                let score = match fp {
                    Some(fp) => fingerprint_score(candidate, fp, recorded_index),
                    None => 1,
                };
                debug_log(&format!(
                    "RESOLVE: depth {depth}: fast path candidate at {recorded_index} score={score} {}",
                    snapshot_element("", candidate)
                ));
                if score > 0 {
                    chosen = Some(recorded_index);
                    chosen_score = score;
                }
            }
        }

        // Sibling scan: pick the highest-scoring sibling when the recorded
        // index didn't match. Only runs when we have a fingerprint.
        if chosen.is_none() {
            if let Some(fp) = fp {
                let mut best: Option<(u32, usize)> = None;
                for i in 0..count {
                    let candidate = CFArrayGetValueAtIndex(arr, i as isize);
                    if candidate.is_null() {
                        continue;
                    }
                    let score = fingerprint_score(candidate, fp, i);
                    if score > 0 {
                        debug_log(&format!(
                            "RESOLVE: depth {depth}: sibling [{i}] score={score} {}",
                            snapshot_element("", candidate)
                        ));
                        if best.is_none_or(|(s, _)| score > s) {
                            best = Some((score, i));
                        }
                    }
                }
                if let Some((s, i)) = best {
                    debug_log(&format!(
                        "RESOLVE: depth {depth}: best sibling = [{i}] score={s}"
                    ));
                    chosen = Some(i);
                    chosen_score = s;
                } else if recorded_index < count {
                    // Best-effort fallback: nothing matched the fingerprint
                    // but the recorded index is at least within range. The
                    // tree may have shifted attributes; warn loudly but
                    // proceed so the user sees their binding work.
                    debug_log(&format!(
                        "RESOLVE: depth {depth}: NO sibling matched fingerprint (expected role={:?}); falling back to recorded index {recorded_index}",
                        fp.ax_role
                    ));
                    log::warn!(
                        "[resolve_element] depth {depth}: no fingerprint match \
(expected role={:?} title={:?} description={:?} identifier={:?}); \
falling back to recorded index {recorded_index} of {count}",
                        fp.ax_role,
                        fp.ax_title,
                        fp.ax_description,
                        fp.ax_identifier,
                    );
                    chosen = Some(recorded_index);
                }
            } else if recorded_index < count {
                chosen = Some(recorded_index);
            }
        }
        debug_log(&format!(
            "RESOLVE: depth {depth}: chosen={chosen:?} score={chosen_score}"
        ));

        let Some(idx) = chosen else {
            let summary = describe_children(arr, count);
            CFRelease(children_ref);
            if current != app_element {
                CFRelease(current);
            }
            CFRelease(app_element);
            return Err(format!(
                "depth {depth}: no candidate. Recorded index {recorded_index}, \
sibling count {count}, expected fingerprint {{role={:?}, title={:?}, \
description={:?}, identifier={:?}}}. Available children: {summary}",
                fp.and_then(|f| f.ax_role.as_deref()),
                fp.and_then(|f| f.ax_title.as_deref()),
                fp.and_then(|f| f.ax_description.as_deref()),
                fp.and_then(|f| f.ax_identifier.as_deref()),
            ));
        };

        let child = CFArrayGetValueAtIndex(arr, idx as isize);
        if child.is_null() {
            CFRelease(children_ref);
            if current != app_element {
                CFRelease(current);
            }
            CFRelease(app_element);
            return Err(format!("depth {depth}: child at index {idx} is null"));
        }

        core_foundation::base::CFRetain(child);
        CFRelease(children_ref);

        if current != app_element {
            CFRelease(current);
        }
        current = child;
    }

    if current == app_element {
        CFRelease(app_element);
        debug_log("RESOLVE: empty index path");
        return Err("empty index path".to_string());
    }

    debug_log(&snapshot_element(
        "RESOLVE: success final element = ",
        current,
    ));
    CFRelease(app_element);
    Ok(current)
}

/// Build a human-readable summary of the children at a given level. Used
/// only for error messages, so the per-element get_string_attribute calls
/// are acceptable here even though they aren't cheap.
unsafe fn describe_children(arr: core_foundation::array::CFArrayRef, count: usize) -> String {
    if count == 0 {
        return "<empty>".to_string();
    }
    let mut parts: Vec<String> = Vec::with_capacity(count);
    for i in 0..count {
        let child = CFArrayGetValueAtIndex(arr, i as isize);
        if child.is_null() {
            parts.push(format!("[{i}]=<null>"));
            continue;
        }
        let role = get_string_attribute(child, CFString::new("AXRole").as_concrete_TypeRef());
        let title = get_string_attribute(child, CFString::new("AXTitle").as_concrete_TypeRef());
        let desc =
            get_string_attribute(child, CFString::new("AXDescription").as_concrete_TypeRef());
        let id = get_string_attribute(child, CFString::new("AXIdentifier").as_concrete_TypeRef());
        let mut s = format!("[{i}] role={:?}", role.as_deref().unwrap_or(""));
        if let Some(t) = &title {
            s.push_str(&format!(" title={t:?}"));
        }
        if let Some(d) = &desc {
            s.push_str(&format!(" desc={d:?}"));
        }
        if let Some(id) = &id {
            s.push_str(&format!(" id={id:?}"));
        }
        parts.push(s);
    }
    let joined = parts.join(", ");
    if joined.len() > 800 {
        format!("{}... ({count} children total)", &joined[..800])
    } else {
        joined
    }
}

unsafe fn write_accessibility_fields_impl(
    entries: Vec<crate::commands::AccessibilityWriteEntry>,
) -> crate::commands::AccessibilityWriteResult {
    let ax_value = CFString::new("AXValue");
    let mut succeeded = 0usize;
    let mut failed = 0usize;
    let mut errors: Vec<String> = Vec::new();

    for entry in &entries {
        debug_log(&format!(
            "\n=== WRITE entry pid={} path={:?} value={:?} ===",
            entry.app_pid,
            entry.element_index_path,
            entry.value.chars().take(60).collect::<String>(),
        ));

        let element = match resolve_element(
            entry.app_pid,
            &entry.element_index_path,
            entry.fingerprint_chain.as_deref(),
        ) {
            Ok(e) => e,
            Err(err) => {
                debug_log(&format!("WRITE: resolve failed: {err}"));
                failed += 1;
                errors.push(format!(
                    "Could not resolve element for PID {} path {:?}: {err}",
                    entry.app_pid, entry.element_index_path
                ));
                continue;
            }
        };

        let mut settable = false;
        AXUIElementIsAttributeSettable(element, ax_value.as_concrete_TypeRef(), &mut settable);
        debug_log(&format!("WRITE: AXValue settable={settable}"));

        let mut wrote = false;
        let mut ax_set_error: Option<String> = None;

        if settable {
            let cf_text = CFString::new(&entry.value);
            let set_result = AXUIElementSetAttributeValue(
                element,
                ax_value.as_concrete_TypeRef(),
                cf_text.as_CFTypeRef(),
            );
            debug_log(&format!("WRITE: AXValue set result={set_result}"));
            if set_result == AX_ERROR_SUCCESS {
                wrote = true;
            } else {
                ax_set_error = Some(format!(
                    "AXUIElementSetAttributeValue failed with {}",
                    set_result
                ));
            }
        }

        // AXValue isn't settable on most Java Swing widgets. Try replacing
        // via AXSelectedText next — same outcome (full text replaced) but
        // routed through the selection API, which Java's CAccessible often
        // implements even when the value setter isn't wired. No cursor
        // movement, no keystrokes.
        if !wrote && try_replace_via_selected_text(element, &entry.value) {
            debug_log("WRITE: replaced via AXSelectedText");
            wrote = true;
        }

        CFRelease(element);

        // Java Swing (and a handful of other toolkits) report AXValue as
        // not-settable even when the field is editable. Fall back to a
        // focus + Cmd+A + Cmd+V clipboard paste — same approach Windows
        // uses for JAB ClipboardPaste.
        if !wrote {
            debug_log("WRITE: falling back to clipboard paste");
            match clipboard_paste_into_element(
                entry.app_pid,
                &entry.element_index_path,
                entry.fingerprint_chain.as_deref(),
                &entry.value,
            ) {
                Ok(()) => {
                    debug_log("WRITE: clipboard paste reported success");
                    wrote = true;
                }
                Err(err) => {
                    debug_log(&format!("WRITE: clipboard paste FAILED: {err}"));
                    let prefix = ax_set_error
                        .map(|e| format!("{e}; "))
                        .unwrap_or_else(|| "AXValue not settable; ".to_string());
                    errors.push(format!(
                        "{}clipboard paste failed for PID {} path {:?}: {}",
                        prefix, entry.app_pid, entry.element_index_path, err
                    ));
                }
            }
        }

        if wrote {
            succeeded += 1;
        } else {
            failed += 1;
        }
    }

    crate::commands::AccessibilityWriteResult {
        succeeded,
        failed,
        errors,
    }
}

/// Paste `value` into the element at `element_index_path` via Cmd+A + Cmd+V.
///
/// Re-resolves the element fresh after raising the app, because raising
/// invalidates any AXUIElement reference taken before activation (you'll see
/// kAXErrorInvalidUIElement / -25202 if you reuse the old handle).
///
/// Deliberately does NOT save/restore the clipboard: when multiple writes are
/// batched, a delayed restore would race with subsequent entries. The caller
/// (the JS layer) owns clipboard state.
unsafe fn clipboard_paste_into_element(
    app_pid: i32,
    element_index_path: &[usize],
    fingerprint_chain: Option<&[crate::commands::ElementFingerprint]>,
    value: &str,
) -> Result<(), String> {
    debug_log(&format!(
        "\n=== CLIPBOARD_PASTE pid={app_pid} path={element_index_path:?} ==="
    ));

    let app_element = AXUIElementCreateApplication(app_pid);
    if app_element.is_null() {
        debug_log("CLIPBOARD_PASTE: AXUIElementCreateApplication returned null");
        return Err("could not create application element".to_string());
    }
    let raise_attr = CFString::new("AXFrontmost");
    let cf_true = core_foundation::boolean::CFBoolean::true_value();
    AXUIElementSetAttributeValue(
        app_element,
        raise_attr.as_concrete_TypeRef(),
        cf_true.as_CFTypeRef(),
    );
    CFRelease(app_element);
    debug_log("CLIPBOARD_PASTE: raised app, sleeping 150ms");

    // Let the activation propagate — the AX tree is rebuilt on raise, so any
    // pre-raise element reference is now stale.
    std::thread::sleep(std::time::Duration::from_millis(150));

    let element =
        resolve_element(app_pid, element_index_path, fingerprint_chain).map_err(|err| {
            debug_log(&format!("CLIPBOARD_PASTE: re-resolve failed: {err}"));
            format!("could not re-resolve element after raise: {err}")
        })?;

    debug_log(&snapshot_element(
        "CLIPBOARD_PASTE: re-resolved element = ",
        element,
    ));

    // Java's CAccessible doesn't actually move focus in response to AXPress
    // (returns success without doing anything), so the only mechanism that
    // reliably focuses a Swing widget is a real synthesized click. Cursor
    // visibly jumps to the field, paste happens, and we warp it back at
    // the end so user mouse intent isn't disrupted permanently.
    let element_center = get_element_center(element);
    CFRelease(element);

    let center = element_center.ok_or_else(|| {
        debug_log("CLIPBOARD_PASTE: element has no AXPosition/AXSize");
        format!(
            "element has no AXPosition/AXSize at path {element_index_path:?}; can't focus for paste"
        )
    })?;

    debug_log(&format!(
        "CLIPBOARD_PASTE: posting click to pid {app_pid} at ({:.1}, {:.1}) — cursor will not move",
        center.x, center.y
    ));
    simulate_click_to_pid(app_pid, center).map_err(|err| {
        debug_log(&format!("CLIPBOARD_PASTE: focus click failed: {err}"));
        format!("focus click failed: {err}")
    })?;

    debug_log("CLIPBOARD_PASTE: click sent, sleeping 120ms for focus to land");
    std::thread::sleep(std::time::Duration::from_millis(120));

    let mut clipboard =
        arboard::Clipboard::new().map_err(|err| format!("clipboard unavailable: {err}"))?;
    clipboard
        .set_text(value.to_string())
        .map_err(|err| format!("failed to set clipboard: {err}"))?;
    debug_log("CLIPBOARD_PASTE: clipboard set, sleeping 80ms then Cmd+A");

    std::thread::sleep(std::time::Duration::from_millis(80));
    crate::platform::macos::input::simulate_cmd_a()
        .map_err(|err| format!("Cmd+A failed: {err}"))?;
    debug_log("CLIPBOARD_PASTE: Cmd+A sent, sleeping 30ms then Cmd+V");
    std::thread::sleep(std::time::Duration::from_millis(30));
    crate::platform::macos::input::simulate_cmd_v()
        .map_err(|err| format!("Cmd+V failed: {err}"))?;
    debug_log("CLIPBOARD_PASTE: Cmd+V sent, sleeping 60ms");
    std::thread::sleep(std::time::Duration::from_millis(60));

    debug_log("CLIPBOARD_PASTE: done");
    Ok(())
}

/// Read AXPosition + AXSize off an element and return its screen-space
/// center. Returns None when either attribute is missing — common on
/// container/structural nodes, but text fields generally have both.
unsafe fn get_element_center(element: CFTypeRef) -> Option<core_graphics::geometry::CGPoint> {
    use core_graphics::geometry::{CGPoint, CGSize};

    let mut position = CGPoint { x: 0.0, y: 0.0 };
    let pos_attr = CFString::new("AXPosition");
    let mut pos_value: CFTypeRef = ptr::null();
    if AXUIElementCopyAttributeValue(element, pos_attr.as_concrete_TypeRef(), &mut pos_value)
        != AX_ERROR_SUCCESS
        || pos_value.is_null()
    {
        return None;
    }
    let pos_ok = AXValueGetValue(
        pos_value,
        AX_VALUE_TYPE_CG_POINT,
        &mut position as *mut _ as *mut c_void,
    );
    CFRelease(pos_value);
    if !pos_ok {
        return None;
    }

    let mut size = CGSize {
        width: 0.0,
        height: 0.0,
    };
    let size_attr = CFString::new("AXSize");
    let mut size_value: CFTypeRef = ptr::null();
    if AXUIElementCopyAttributeValue(element, size_attr.as_concrete_TypeRef(), &mut size_value)
        != AX_ERROR_SUCCESS
        || size_value.is_null()
    {
        return None;
    }
    let size_ok = AXValueGetValue(
        size_value,
        AX_VALUE_TYPE_CG_SIZE,
        &mut size as *mut _ as *mut c_void,
    );
    CFRelease(size_value);
    if !size_ok {
        return None;
    }

    Some(CGPoint {
        x: position.x + size.width / 2.0,
        y: position.y + size.height / 2.0,
    })
}

/// Try to replace the element's full text by setting AXSelectedTextRange
/// to span the whole field and then setting AXSelectedText to the new
/// value. No focus, click, or keystrokes — entirely AX-level. Returns
/// true on success. Java's CAccessible reports AXValue as not-settable
/// for many text widgets but often does accept AXSelectedText edits, so
/// this is the cheapest path to try before falling back to a click.
unsafe fn try_replace_via_selected_text(element: CFTypeRef, value: &str) -> bool {
    let ax_value = CFString::new("AXValue");
    let ax_selected_text = CFString::new("AXSelectedText");
    let ax_selected_text_range = CFString::new("AXSelectedTextRange");

    let mut settable = false;
    let r = AXUIElementIsAttributeSettable(
        element,
        ax_selected_text.as_concrete_TypeRef(),
        &mut settable,
    );
    if r != AX_ERROR_SUCCESS || !settable {
        return false;
    }

    // Length of the existing text (in UTF-16 code units, which is what
    // AXSelectedTextRange uses on macOS).
    let length: isize = match get_string_attribute(element, ax_value.as_concrete_TypeRef()) {
        Some(s) => s.encode_utf16().count() as isize,
        None => 0,
    };

    let range = CFRange {
        location: 0,
        length,
    };
    let range_value = AXValueCreate(AX_VALUE_TYPE_CF_RANGE, &range as *const _ as *const c_void);
    if range_value.is_null() {
        return false;
    }
    let r = AXUIElementSetAttributeValue(
        element,
        ax_selected_text_range.as_concrete_TypeRef(),
        range_value,
    );
    CFRelease(range_value);
    if r != AX_ERROR_SUCCESS {
        return false;
    }

    let cf_text = CFString::new(value);
    let r = AXUIElementSetAttributeValue(
        element,
        ax_selected_text.as_concrete_TypeRef(),
        cf_text.as_CFTypeRef(),
    );
    r == AX_ERROR_SUCCESS
}

/// Inject a left-mouse click at the given screen-space point, delivered
/// directly to the target process via CGEventPostToPid. Bypasses the
/// global HID/cursor positioning layer so the user's cursor does NOT
/// move — the target app receives the click as if it happened at `point`,
/// but macOS never repositions the cursor in response.
fn simulate_click_to_pid(pid: i32, point: core_graphics::geometry::CGPoint) -> Result<(), String> {
    use core_graphics::event::{CGEvent, CGEventType, CGMouseButton};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    let source = CGEventSource::new(CGEventSourceStateID::Private)
        .map_err(|_| "failed to create mouse event source".to_string())?;

    let down = CGEvent::new_mouse_event(
        source.clone(),
        CGEventType::LeftMouseDown,
        point,
        CGMouseButton::Left,
    )
    .map_err(|_| "failed to create mouse-down event".to_string())?;
    down.post_to_pid(pid);

    std::thread::sleep(std::time::Duration::from_millis(15));

    let up = CGEvent::new_mouse_event(source, CGEventType::LeftMouseUp, point, CGMouseButton::Left)
        .map_err(|_| "failed to create mouse-up event".to_string())?;
    up.post_to_pid(pid);

    Ok(())
}

pub fn read_field_values(
    fields: Vec<crate::commands::FieldValueRequest>,
) -> Vec<crate::commands::FieldValueResult> {
    let len = fields.len();
    catch_unwind(AssertUnwindSafe(|| unsafe {
        read_field_values_impl(fields)
    }))
    .unwrap_or_else(|_| {
        log::error!("read_field_values panicked");
        (0..len)
            .map(|_| crate::commands::FieldValueResult {
                value: None,
                error: Some("read_field_values panicked".to_string()),
            })
            .collect()
    })
}

unsafe fn read_field_values_impl(
    fields: Vec<crate::commands::FieldValueRequest>,
) -> Vec<crate::commands::FieldValueResult> {
    let ax_value = CFString::new("AXValue");
    fields
        .into_iter()
        .map(|field| {
            debug_log(&format!(
                "\n=== READ field pid={} path={:?} ===",
                field.app_pid, field.element_index_path
            ));
            let element = match resolve_element(
                field.app_pid,
                &field.element_index_path,
                field.fingerprint_chain.as_deref(),
            ) {
                Ok(e) => e,
                Err(err) => {
                    debug_log(&format!("READ: resolve failed: {err}"));
                    return crate::commands::FieldValueResult {
                        value: None,
                        error: Some(format!(
                            "Could not resolve element for PID {} path {:?}: {err}",
                            field.app_pid, field.element_index_path
                        )),
                    };
                }
            };

            let value = get_string_attribute(element, ax_value.as_concrete_TypeRef());
            debug_log(&format!(
                "READ: got value={:?}",
                value
                    .as_ref()
                    .map(|v| v.chars().take(60).collect::<String>())
            ));
            CFRelease(element);

            crate::commands::FieldValueResult {
                value: Some(value.unwrap_or_default()),
                error: None,
            }
        })
        .collect()
}

pub fn capture_app_identity(pid: i32) -> Option<crate::commands::AppIdentity> {
    use cocoa::base::{id, nil};
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;
    use std::os::raw::c_char;

    catch_unwind(AssertUnwindSafe(|| unsafe {
        let pool: id = msg_send![class!(NSAutoreleasePool), new];
        let app: id = msg_send![
            class!(NSRunningApplication),
            runningApplicationWithProcessIdentifier: pid
        ];
        if app == nil {
            let _: () = msg_send![pool, drain];
            return None;
        }

        let bundle_id_ns: id = msg_send![app, bundleIdentifier];
        let bundle_id = if bundle_id_ns == nil {
            None
        } else {
            let utf8: *const c_char = msg_send![bundle_id_ns, UTF8String];
            if utf8.is_null() {
                None
            } else {
                Some(CStr::from_ptr(utf8).to_string_lossy().into_owned())
            }
        };

        let _: () = msg_send![pool, drain];

        bundle_id.as_ref()?;

        Some(crate::commands::AppIdentity {
            exe_path: None,
            exe_name: None,
            bundle_id,
        })
    }))
    .unwrap_or(None)
}

pub fn resolve_app_pids(
    identity: &crate::commands::AppIdentity,
) -> Vec<crate::commands::AppProcessMatch> {
    use cocoa::base::{id, nil};
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;
    use std::os::raw::c_char;

    let Some(expected_bundle) = identity.bundle_id.as_deref() else {
        return Vec::new();
    };

    catch_unwind(AssertUnwindSafe(|| unsafe {
        let pool: id = msg_send![class!(NSAutoreleasePool), new];
        let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        let apps: id = msg_send![workspace, runningApplications];
        if apps == nil {
            let _: () = msg_send![pool, drain];
            return Vec::new();
        }

        let count: usize = msg_send![apps, count];
        let mut matches = Vec::new();
        for i in 0..count {
            let app: id = msg_send![apps, objectAtIndex: i];
            if app == nil {
                continue;
            }

            let bundle_ns: id = msg_send![app, bundleIdentifier];
            if bundle_ns == nil {
                continue;
            }
            let bundle_utf8: *const c_char = msg_send![bundle_ns, UTF8String];
            if bundle_utf8.is_null() {
                continue;
            }
            let bundle = CStr::from_ptr(bundle_utf8).to_string_lossy();
            if bundle != expected_bundle {
                continue;
            }

            let pid: i32 = msg_send![app, processIdentifier];
            let name_ns: id = msg_send![app, localizedName];
            let app_name = if name_ns == nil {
                None
            } else {
                let utf8: *const c_char = msg_send![name_ns, UTF8String];
                if utf8.is_null() {
                    None
                } else {
                    Some(CStr::from_ptr(utf8).to_string_lossy().into_owned())
                }
            };

            matches.push(crate::commands::AppProcessMatch {
                pid,
                exe_path: None,
                app_name,
                window_title: None,
            });
        }

        let _: () = msg_send![pool, drain];
        matches
    }))
    .unwrap_or_default()
}
