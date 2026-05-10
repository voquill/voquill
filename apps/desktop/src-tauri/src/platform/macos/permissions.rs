use crate::domain::{PermissionKind, PermissionState, PermissionStatus};
use block::ConcreteBlock;
use cocoa::base::{id, nil};
use cocoa::foundation::{NSAutoreleasePool, NSString};
use core_foundation::{
    base::TCFType, boolean::CFBoolean, dictionary::CFDictionary, string::CFString,
};
use core_foundation_sys::{dictionary::CFDictionaryRef, string::CFStringRef};
use objc::{class, msg_send, sel, sel_impl};
use std::sync::{Arc, Condvar, Mutex};

const AUTH_STATUS_NOT_DETERMINED: i64 = 0;
const AUTH_STATUS_RESTRICTED: i64 = 1;
const AUTH_STATUS_DENIED: i64 = 2;
const AUTH_STATUS_AUTHORIZED: i64 = 3;
const SCREEN_RECORDING_REQUESTED_KEY: &str = "voquill.permission.screen-recording-requested";

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
    static kAXTrustedCheckOptionPrompt: CFStringRef;
}

// CGPreflightScreenCaptureAccess and CGRequestScreenCaptureAccess are CoreGraphics
// symbols declared separately to avoid depending on ApplicationServices umbrella re-exports,
// which Apple has been progressively breaking in newer SDKs.
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[link(name = "AVFoundation", kind = "framework")]
extern "C" {
    static AVMediaTypeAudio: id;
}

pub(crate) fn check_microphone_permission() -> Result<PermissionStatus, String> {
    unsafe {
        let pool = NSAutoreleasePool::new(nil);
        let result = (|| {
            let status: i64 = msg_send![
                class!(AVCaptureDevice),
                authorizationStatusForMediaType: AVMediaTypeAudio
            ];
            let state = permission_state_from_authorization(status)?;
            Ok(PermissionStatus {
                kind: PermissionKind::Microphone,
                state,
                prompt_shown: false,
            })
        })();
        pool.drain();
        result
    }
}

pub(crate) fn request_microphone_permission() -> Result<PermissionStatus, String> {
    unsafe {
        let pool = NSAutoreleasePool::new(nil);
        let result = (|| {
            log::debug!("request_microphone_permission invoked");
            let class = class!(AVCaptureDevice);
            let initial_status: i64 =
                msg_send![class, authorizationStatusForMediaType: AVMediaTypeAudio];
            log::debug!(
                "request_microphone_permission initial_status={}",
                initial_status
            );
            let prompt_shown = initial_status == AUTH_STATUS_NOT_DETERMINED;
            log::debug!(
                "request_microphone_permission prompt_shown={}",
                prompt_shown
            );

            let mut prompt_result = prompt_shown;

            if initial_status == AUTH_STATUS_DENIED {
                log::warn!(
                    "Microphone permission previously denied; directing user to System Settings"
                );
                if open_microphone_privacy_settings() {
                    prompt_result = true;
                } else {
                    log::error!("Failed to open System Settings privacy pane for microphone");
                }
            }

            if prompt_shown {
                let state_pair = Arc::new((Mutex::new(None::<bool>), Condvar::new()));
                let state_pair_clone = Arc::clone(&state_pair);

                let handler = ConcreteBlock::new(move |granted: bool| {
                    log::debug!("Microphone permission callback invoked granted={}", granted);
                    let (lock, cvar) = &*state_pair_clone;
                    if let Ok(mut slot) = lock.lock() {
                        *slot = Some(granted);
                        cvar.notify_one();
                    }
                })
                .copy();

                let _: () = msg_send![
                    class,
                    requestAccessForMediaType: AVMediaTypeAudio
                    completionHandler: &*handler
                ];
                log::debug!("Waiting for microphone prompt response");

                let (lock, cvar) = &*state_pair;
                let mut result = lock
                    .lock()
                    .map_err(|_| "Microphone request mutex poisoned".to_string())?;
                while result.is_none() {
                    result = cvar
                        .wait(result)
                        .map_err(|_| "Microphone request mutex poisoned".to_string())?;
                }
                let granted_value = result.as_ref().copied().unwrap_or(false);
                log::debug!("Microphone prompt resolved granted={}", granted_value);
            }

            let final_status: i64 =
                msg_send![class, authorizationStatusForMediaType: AVMediaTypeAudio];
            log::debug!(
                "request_microphone_permission final_status={}",
                final_status
            );
            let state = permission_state_from_authorization(final_status)?;
            log::debug!("request_microphone_permission resolved_state={:?}", state);

            Ok(PermissionStatus {
                kind: PermissionKind::Microphone,
                state,
                prompt_shown: prompt_result,
            })
        })();
        pool.drain();
        result
    }
}

pub(crate) fn check_screen_recording_permission() -> Result<PermissionStatus, String> {
    unsafe {
        let pool = NSAutoreleasePool::new(nil);
        let result = (|| {
            let authorized = CGPreflightScreenCaptureAccess();
            let requested_before = has_requested_screen_recording_permission();
            Ok(screen_recording_status(authorized, false, requested_before))
        })();
        pool.drain();
        result
    }
}

pub(crate) fn request_screen_recording_permission() -> Result<PermissionStatus, String> {
    unsafe {
        let pool = NSAutoreleasePool::new(nil);
        let result = (|| {
            log::debug!("request_screen_recording_permission invoked");
            let initial_authorized = CGPreflightScreenCaptureAccess();
            let requested_before = has_requested_screen_recording_permission();
            let mut opened_settings = false;

            if !initial_authorized && requested_before {
                log::warn!(
                    "Screen recording permission previously denied; directing user to System Settings"
                );
                if open_screen_recording_privacy_settings() {
                    opened_settings = true;
                } else {
                    log::error!(
                        "Failed to open System Settings privacy pane for screen recording"
                    );
                }
            } else if !initial_authorized {
                mark_screen_recording_permission_requested();
                let request_result = CGRequestScreenCaptureAccess();
                log::debug!(
                    "request_screen_recording_permission request_result={}",
                    request_result
                );
            }

            let prompt_shown = screen_recording_prompt_result(
                initial_authorized,
                requested_before,
                opened_settings,
            );
            let final_authorized = CGPreflightScreenCaptureAccess();
            Ok(screen_recording_status(
                final_authorized,
                prompt_shown,
                requested_before || prompt_shown,
            ))
        })();
        pool.drain();
        result
    }
}

fn permission_state_from_authorization(status: i64) -> Result<PermissionState, String> {
    match status {
        AUTH_STATUS_AUTHORIZED => Ok(PermissionState::Authorized),
        AUTH_STATUS_DENIED => Ok(PermissionState::Denied),
        AUTH_STATUS_RESTRICTED => Ok(PermissionState::Restricted),
        AUTH_STATUS_NOT_DETERMINED => Ok(PermissionState::NotDetermined),
        other => {
            log::error!("Unexpected microphone authorization status={}", other);
            Err(format!("Unknown authorization status: {}", other))
        }
    }
}

fn screen_recording_state_from_access(
    authorized: bool,
    requested_before: bool,
) -> PermissionState {
    if authorized {
        PermissionState::Authorized
    } else if requested_before {
        PermissionState::Denied
    } else {
        PermissionState::NotDetermined
    }
}

fn screen_recording_status(
    authorized: bool,
    prompt_shown: bool,
    requested_before: bool,
) -> PermissionStatus {
    PermissionStatus {
        kind: PermissionKind::ScreenRecording,
        state: screen_recording_state_from_access(authorized, requested_before),
        prompt_shown,
    }
}

fn screen_recording_prompt_result(
    initial_authorized: bool,
    requested_before: bool,
    opened_settings: bool,
) -> bool {
    if initial_authorized {
        false
    } else if requested_before {
        opened_settings
    } else {
        true
    }
}

unsafe fn has_requested_screen_recording_permission() -> bool {
    let defaults: id = msg_send![class!(NSUserDefaults), standardUserDefaults];
    let key = NSString::alloc(nil).init_str(SCREEN_RECORDING_REQUESTED_KEY);
    let has_requested: bool = msg_send![defaults, boolForKey: key];
    let _: () = msg_send![key, release];
    has_requested
}

unsafe fn mark_screen_recording_permission_requested() {
    let defaults: id = msg_send![class!(NSUserDefaults), standardUserDefaults];
    let key = NSString::alloc(nil).init_str(SCREEN_RECORDING_REQUESTED_KEY);
    let _: () = msg_send![defaults, setBool: true forKey: key];
    let _: () = msg_send![key, release];
}

fn open_screen_recording_privacy_settings() -> bool {
    unsafe {
        let url_string = NSString::alloc(nil).init_str(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        );
        let url: id = msg_send![class!(NSURL), URLWithString: url_string];
        if url == nil {
            let _: () = msg_send![url_string, release];
            return false;
        }

        let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        let success: bool = msg_send![workspace, openURL: url];

        let _: () = msg_send![url_string, release];

        success
    }
}

fn open_microphone_privacy_settings() -> bool {
    unsafe {
        let url_string = NSString::alloc(nil)
            .init_str("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
        let url: id = msg_send![class!(NSURL), URLWithString: url_string];
        if url == nil {
            let _: () = msg_send![url_string, release];
            return false;
        }

        let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        let success: bool = msg_send![workspace, openURL: url];

        let _: () = msg_send![url_string, release];

        success
    }
}

pub(crate) fn check_accessibility_permission() -> Result<PermissionStatus, String> {
    unsafe {
        let trusted = AXIsProcessTrusted();
        Ok(PermissionStatus {
            kind: PermissionKind::Accessibility,
            state: accessibility_state_from_bool(trusted),
            prompt_shown: false,
        })
    }
}

fn accessibility_state_from_bool(trusted: bool) -> PermissionState {
    if trusted {
        PermissionState::Authorized
    } else {
        PermissionState::NotDetermined
    }
}

pub(crate) fn request_accessibility_permission() -> Result<PermissionStatus, String> {
    unsafe {
        log::debug!("request_accessibility_permission invoked");
        let initial_trusted = AXIsProcessTrusted();
        log::debug!(
            "request_accessibility_permission initial_trusted={}",
            initial_trusted
        );

        let mut prompt_shown = false;
        if !initial_trusted {
            prompt_shown = true;
            let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
            let prompt_value = CFBoolean::true_value();
            let options: CFDictionary<CFString, CFBoolean> =
                CFDictionary::from_CFType_pairs(&[(key, prompt_value)]);
            let request_result = AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef());
            log::debug!(
                "request_accessibility_permission request_result={}",
                request_result
            );
        }

        let final_trusted = AXIsProcessTrusted();
        log::debug!(
            "request_accessibility_permission final_trusted={}",
            final_trusted
        );

        Ok(PermissionStatus {
            kind: PermissionKind::Accessibility,
            state: accessibility_state_from_bool(final_trusted),
            prompt_shown,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screen_recording_status_uses_screen_recording_kind() {
        let status = screen_recording_status(true, false, false);

        assert_eq!(status.kind, PermissionKind::ScreenRecording);
        assert_eq!(status.state, PermissionState::Authorized);
        assert!(!status.prompt_shown);
    }

    #[test]
    fn screen_recording_status_without_prior_request_is_not_determined() {
        let status = screen_recording_status(false, false, false);

        assert_eq!(status.kind, PermissionKind::ScreenRecording);
        assert_eq!(status.state, PermissionState::NotDetermined);
        assert!(!status.prompt_shown);
    }

    #[test]
    fn screen_recording_status_after_prior_request_without_access_is_denied() {
        let status = screen_recording_status(false, false, true);

        assert_eq!(status.kind, PermissionKind::ScreenRecording);
        assert_eq!(status.state, PermissionState::Denied);
        assert!(!status.prompt_shown);
    }

    #[test]
    fn screen_recording_status_after_prompt_without_access_is_denied() {
        let status = screen_recording_status(false, true, true);

        assert_eq!(status.kind, PermissionKind::ScreenRecording);
        assert_eq!(status.state, PermissionState::Denied);
        assert!(status.prompt_shown);
    }

    #[test]
    fn screen_recording_prompt_result_is_true_for_first_request() {
        assert!(screen_recording_prompt_result(false, false, false));
    }

    #[test]
    fn screen_recording_prompt_result_matches_settings_redirect_for_prior_denial() {
        assert!(screen_recording_prompt_result(false, true, true));
        assert!(!screen_recording_prompt_result(false, true, false));
    }
}
