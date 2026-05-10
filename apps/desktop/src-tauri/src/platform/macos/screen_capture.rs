#![allow(clippy::missing_safety_doc)]

use block::ConcreteBlock;
use cocoa::base::{id, nil, YES};
use cocoa::foundation::{NSRect, NSString};
use core_foundation::base::CFRelease;
use core_graphics::geometry::{CGPoint, CGRect, CGSize};
use objc::runtime::Class;
use objc::{class, msg_send, sel, sel_impl};
use std::ffi::{c_void, CStr};
use std::os::raw::c_char;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc;
use std::time::Duration;

const CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY: u32 = 1 << 0;
const CG_WINDOW_LIST_OPTION_EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;

type CGImageRef = *mut c_void;

#[link(name = "ScreenCaptureKit", kind = "framework")]
extern "C" {}

#[link(name = "Vision", kind = "framework")]
extern "C" {}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> *mut c_void;
    fn CGImageRetain(image: CGImageRef) -> CGImageRef;
    fn CGImageRelease(image: CGImageRef);
}

struct RetainedObjcObject {
    object: id,
}

impl RetainedObjcObject {
    fn new(object: id) -> Self {
        Self { object }
    }

    fn as_id(&self) -> id {
        self.object
    }
}

impl Drop for RetainedObjcObject {
    fn drop(&mut self) {
        if self.object != nil {
            unsafe {
                let _: () = msg_send![self.object, release];
            }
        }
    }
}

struct RetainedCgImage {
    image: CGImageRef,
}

impl RetainedCgImage {
    fn new(image: CGImageRef) -> Self {
        Self { image }
    }

    fn as_ptr(&self) -> CGImageRef {
        self.image
    }
}

impl Drop for RetainedCgImage {
    fn drop(&mut self) {
        if !self.image.is_null() {
            unsafe {
                CGImageRelease(self.image);
            }
        }
    }
}

struct AutoreleasePoolGuard {
    pool: id,
}

impl AutoreleasePoolGuard {
    fn new(pool: id) -> Self {
        Self { pool }
    }
}

impl Drop for AutoreleasePoolGuard {
    fn drop(&mut self) {
        if self.pool != nil {
            unsafe {
                let _: () = msg_send![self.pool, drain];
            }
        }
    }
}

pub fn get_screen_capture_context() -> Result<Option<String>, String> {
    log::info!("get_screen_capture_context: starting OCR screen capture");
    let result = catch_unwind(AssertUnwindSafe(|| unsafe {
        let pool = AutoreleasePoolGuard::new(msg_send![class!(NSAutoreleasePool), new]);
        let result = get_screen_capture_context_impl();
        drop(pool);
        result
    }))
    .map_err(|_| "get_screen_capture_context panicked".to_string())?;
    log::info!("get_screen_capture_context: result={:?}", result);
    result
}

unsafe fn get_screen_capture_context_impl() -> Result<Option<String>, String> {
    let Some(frontmost_pid) = frontmost_pid() else {
        return Ok(None);
    };
    let Some(frontmost_window_id) = frontmost_window_id(frontmost_pid) else {
        return Ok(None);
    };

    let Some(shareable_content_class) = Class::get("SCShareableContent") else {
        return Ok(None);
    };
    let Some(content_filter_class) = Class::get("SCContentFilter") else {
        return Ok(None);
    };
    let Some(stream_configuration_class) = Class::get("SCStreamConfiguration") else {
        return Ok(None);
    };
    let Some(screenshot_manager_class) = Class::get("SCScreenshotManager") else {
        return Ok(None);
    };

    let shareable_selector =
        sel!(getShareableContentExcludingDesktopWindows:onScreenWindowsOnly:completionHandler:);
    let supports_shareable_selector: bool =
        msg_send![shareable_content_class, respondsToSelector: shareable_selector];
    if !supports_shareable_selector {
        return Ok(None);
    }

    let screenshot_selector = sel!(captureImageWithFilter:configuration:completionHandler:);
    let supports_screenshot_selector: bool =
        msg_send![screenshot_manager_class, respondsToSelector: screenshot_selector];
    if !supports_screenshot_selector {
        return Ok(None);
    }

    let shareable_content =
        RetainedObjcObject::new(request_shareable_content(shareable_content_class)?);
    let result = if let Some(window) = find_shareable_window(
        shareable_content.as_id(),
        frontmost_window_id,
        frontmost_pid,
    ) {
        let image = RetainedCgImage::new(capture_window_image(
            screenshot_manager_class,
            content_filter_class,
            stream_configuration_class,
            window,
        )?);
        perform_ocr(image.as_ptr())
    } else {
        Ok(None)
    };

    result
}

unsafe fn frontmost_pid() -> Option<i32> {
    let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
    if workspace == nil {
        return None;
    }

    let app: id = msg_send![workspace, frontmostApplication];
    if app == nil {
        return None;
    }

    let pid: isize = msg_send![app, processIdentifier];
    (pid > 0).then_some(pid as i32)
}

unsafe fn frontmost_window_id(frontmost_pid: i32) -> Option<u32> {
    let window_list_ptr = CGWindowListCopyWindowInfo(
        CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY | CG_WINDOW_LIST_OPTION_EXCLUDE_DESKTOP_ELEMENTS,
        0,
    );
    if window_list_ptr.is_null() {
        return None;
    }

    let window_list = window_list_ptr as id;
    let key_owner_pid = NSString::alloc(nil).init_str("kCGWindowOwnerPID");
    let key_window_number = NSString::alloc(nil).init_str("kCGWindowNumber");
    let key_window_layer = NSString::alloc(nil).init_str("kCGWindowLayer");

    let count: usize = msg_send![window_list, count];
    let mut fallback = None;

    for index in 0..count {
        let window_info: id = msg_send![window_list, objectAtIndex: index];
        if window_info == nil {
            continue;
        }

        let owner_pid_value: id = msg_send![window_info, objectForKey: key_owner_pid];
        if owner_pid_value == nil {
            continue;
        }

        let owner_pid: i32 = msg_send![owner_pid_value, intValue];
        if owner_pid != frontmost_pid {
            continue;
        }

        let window_number_value: id = msg_send![window_info, objectForKey: key_window_number];
        if window_number_value == nil {
            continue;
        }

        let window_number: u32 = msg_send![window_number_value, unsignedIntValue];
        if window_number == 0 {
            continue;
        }

        if fallback.is_none() {
            fallback = Some(window_number);
        }

        let layer_value: id = msg_send![window_info, objectForKey: key_window_layer];
        let layer: isize = if layer_value == nil {
            0
        } else {
            msg_send![layer_value, integerValue]
        };

        if layer == 0 {
            fallback = Some(window_number);
            break;
        }
    }

    let _: () = msg_send![key_owner_pid, release];
    let _: () = msg_send![key_window_number, release];
    let _: () = msg_send![key_window_layer, release];
    CFRelease(window_list_ptr as _);

    fallback
}

unsafe fn request_shareable_content(shareable_content_class: &Class) -> Result<id, String> {
    let (sender, receiver) = mpsc::channel();
    let handler = ConcreteBlock::new(move |content: id, error: id| {
        let result = if error != nil {
            Err(ns_error_to_string(error))
        } else if content == nil {
            Err("shareable content unavailable".to_string())
        } else {
            let retained: id = msg_send![content, retain];
            match sender.send(Ok(retained)) {
                Ok(()) => return,
                Err(send_error) => {
                    if let Ok(retained) = send_error.0 {
                        let _: () = msg_send![retained, release];
                    }
                    return;
                }
            }
        };
        let _ = sender.send(result);
    })
    .copy();

    let _: () = msg_send![
        shareable_content_class,
        getShareableContentExcludingDesktopWindows: YES
        onScreenWindowsOnly: YES
        completionHandler: &*handler
    ];

    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "timed out while loading shareable content".to_string())?
}

unsafe fn find_shareable_window(
    shareable_content: id,
    target_window_id: u32,
    frontmost_pid: i32,
) -> Option<id> {
    let windows: id = msg_send![shareable_content, windows];
    if windows == nil {
        return None;
    }

    let count: usize = msg_send![windows, count];
    let mut pid_fallback = None;

    for index in 0..count {
        let window: id = msg_send![windows, objectAtIndex: index];
        if window == nil {
            continue;
        }

        let window_id: u32 = msg_send![window, windowID];
        if window_id == target_window_id {
            return Some(window);
        }

        if pid_fallback.is_none() {
            let owning_application: id = msg_send![window, owningApplication];
            if owning_application != nil {
                let owning_pid: i32 = {
                    let pid: isize = msg_send![owning_application, processID];
                    pid as i32
                };
                if owning_pid == frontmost_pid {
                    let on_screen = if responds_to(window, sel!(isOnScreen)) {
                        let on_screen_value: bool = msg_send![window, isOnScreen];
                        on_screen_value
                    } else {
                        true
                    };

                    if on_screen {
                        pid_fallback = Some(window);
                    }
                }
            }
        }
    }

    pid_fallback
}

unsafe fn capture_window_image(
    screenshot_manager_class: &Class,
    content_filter_class: &Class,
    stream_configuration_class: &Class,
    window: id,
) -> Result<CGImageRef, String> {
    let filter_alloc: id = msg_send![content_filter_class, alloc];
    let filter = RetainedObjcObject::new(msg_send![
        filter_alloc,
        initWithDesktopIndependentWindow: window
    ]);
    if filter.as_id() == nil {
        return Err("failed to create ScreenCaptureKit content filter".to_string());
    }

    let configuration = RetainedObjcObject::new(msg_send![stream_configuration_class, new]);
    if configuration.as_id() == nil {
        return Err("failed to create ScreenCaptureKit stream configuration".to_string());
    }

    let frame: CGRect = msg_send![window, frame];
    let scale = screen_scale_for_rect(frame);
    let width = (frame.size.width * scale).max(1.0).round() as usize;
    let height = (frame.size.height * scale).max(1.0).round() as usize;
    let _: () = msg_send![configuration.as_id(), setWidth: width];
    let _: () = msg_send![configuration.as_id(), setHeight: height];

    let (sender, receiver) = mpsc::channel();
    let handler = ConcreteBlock::new(move |image: CGImageRef, error: id| {
        let result = if error != nil {
            Err(ns_error_to_string(error))
        } else if image.is_null() {
            Err("screen capture returned no image".to_string())
        } else {
            let retained = CGImageRetain(image);
            match sender.send(Ok(retained)) {
                Ok(()) => return,
                Err(send_error) => {
                    if let Ok(retained) = send_error.0 {
                        CGImageRelease(retained);
                    }
                    return;
                }
            }
        };
        let _ = sender.send(result);
    })
    .copy();

    let _: () = msg_send![
        screenshot_manager_class,
        captureImageWithFilter: filter.as_id()
        configuration: configuration.as_id()
        completionHandler: &*handler
    ];

    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "timed out while capturing the frontmost window".to_string())?
}

unsafe fn screen_scale_for_rect(window_rect: CGRect) -> f64 {
    let screens: id = msg_send![class!(NSScreen), screens];
    if screens == nil {
        return 1.0;
    }

    let count: usize = msg_send![screens, count];
    let mut best_scale = 1.0;
    let mut best_intersection_area = 0.0;

    for index in 0..count {
        let screen: id = msg_send![screens, objectAtIndex: index];
        if screen == nil {
            continue;
        }

        let screen_frame: NSRect = msg_send![screen, frame];
        let screen_rect = CGRect::new(
            &CGPoint::new(screen_frame.origin.x, screen_frame.origin.y),
            &CGSize::new(screen_frame.size.width, screen_frame.size.height),
        );
        let intersection_area = rect_intersection_area(window_rect, screen_rect);
        if intersection_area <= best_intersection_area {
            continue;
        }

        let scale: f64 = msg_send![screen, backingScaleFactor];
        best_intersection_area = intersection_area;
        best_scale = scale.max(1.0);
    }

    if best_intersection_area > 0.0 {
        return best_scale;
    }

    let main_screen: id = msg_send![class!(NSScreen), mainScreen];
    if main_screen == nil {
        return 1.0;
    }

    let scale: f64 = msg_send![main_screen, backingScaleFactor];
    scale.max(1.0)
}

fn rect_intersection_area(a: CGRect, b: CGRect) -> f64 {
    let left = a.origin.x.max(b.origin.x);
    let top = a.origin.y.max(b.origin.y);
    let right = (a.origin.x + a.size.width).min(b.origin.x + b.size.width);
    let bottom = (a.origin.y + a.size.height).min(b.origin.y + b.size.height);

    let width = (right - left).max(0.0);
    let height = (bottom - top).max(0.0);
    width * height
}

unsafe fn perform_ocr(image: CGImageRef) -> Result<Option<String>, String> {
    let Some(recognize_text_request_class) = Class::get("VNRecognizeTextRequest") else {
        return Ok(None);
    };
    let Some(image_request_handler_class) = Class::get("VNImageRequestHandler") else {
        return Ok(None);
    };

    let request: id = msg_send![recognize_text_request_class, new];
    if request == nil {
        return Err("failed to create Vision text recognition request".to_string());
    }

    if responds_to(request, sel!(setUsesLanguageCorrection:)) {
        let _: () = msg_send![request, setUsesLanguageCorrection: YES];
    }
    // Use accurate recognition for better dictation context quality (VNRequestTextRecognitionLevelAccurate = 0).
    // The small CPU overhead is acceptable since OCR runs in parallel with audio processing.
    if responds_to(request, sel!(setRecognitionLevel:)) {
        let _: () = msg_send![request, setRecognitionLevel: 0i64];
    }

    // arrayWithObject: and dictionary return autoreleased objects. They are safe here
    // because the AutoreleasePoolGuard in the calling frame outlives performRequests:error:.
    let requests: id = msg_send![class!(NSArray), arrayWithObject: request];
    let options: id = msg_send![class!(NSDictionary), dictionary];
    let handler_alloc: id = msg_send![image_request_handler_class, alloc];
    let handler: id = msg_send![handler_alloc, initWithCGImage: image options: options];
    if handler == nil {
        let _: () = msg_send![request, release];
        return Err("failed to create Vision image request handler".to_string());
    }

    let mut error: id = nil;
    let success: bool = msg_send![handler, performRequests: requests error: &mut error];
    if !success {
        let message = if error != nil {
            ns_error_to_string(error)
        } else {
            "Vision OCR failed".to_string()
        };
        let _: () = msg_send![handler, release];
        let _: () = msg_send![request, release];
        return Err(message);
    }

    let observations: id = msg_send![request, results];
    let text = recognized_texts_from_observations(observations);

    let _: () = msg_send![handler, release];
    let _: () = msg_send![request, release];

    Ok(text)
}

unsafe fn recognized_texts_from_observations(observations: id) -> Option<String> {
    if observations == nil {
        return None;
    }

    let count: usize = msg_send![observations, count];
    let mut lines = Vec::new();

    for index in 0..count {
        let observation: id = msg_send![observations, objectAtIndex: index];
        if observation == nil {
            continue;
        }

        let candidates: id = msg_send![observation, topCandidates: 1usize];
        if candidates == nil {
            continue;
        }

        let candidate_count: usize = msg_send![candidates, count];
        if candidate_count == 0 {
            continue;
        }

        let top_candidate: id = msg_send![candidates, objectAtIndex: 0usize];
        if top_candidate == nil {
            continue;
        }

        let string_value: id = msg_send![top_candidate, string];
        if let Some(text) = nsstring_to_string(string_value) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                lines.push(trimmed.to_string());
            }
        }
    }

    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
    }
}

unsafe fn responds_to(object: id, selector: objc::runtime::Sel) -> bool {
    if object == nil {
        return false;
    }

    let responds: bool = msg_send![object, respondsToSelector: selector];
    responds
}

unsafe fn ns_error_to_string(error: id) -> String {
    if error == nil {
        return "unknown macOS error".to_string();
    }

    let description: id = msg_send![error, localizedDescription];
    nsstring_to_string(description).unwrap_or_else(|| "unknown macOS error".to_string())
}

unsafe fn nsstring_to_string(string: id) -> Option<String> {
    if string == nil {
        return None;
    }

    let utf8: *const c_char = msg_send![string, UTF8String];
    if utf8.is_null() {
        return None;
    }

    Some(CStr::from_ptr(utf8).to_string_lossy().into_owned())
}
