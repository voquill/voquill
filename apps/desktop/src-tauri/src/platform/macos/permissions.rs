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

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
    static kAXTrustedCheckOptionPrompt: CFStringRef;
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

/// Opens the Privacy & Security pane at `anchor` in System Settings.
fn open_privacy_settings(anchor: &str) -> bool {
    unsafe {
        let url_string = NSString::alloc(nil).init_str(&format!(
            "x-apple.systempreferences:com.apple.preference.security?{anchor}"
        ));
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
    open_privacy_settings("Privacy_Microphone")
}

fn open_accessibility_privacy_settings() -> bool {
    open_privacy_settings("Privacy_Accessibility")
}

/// The "Screen & System Audio Recording" pane, where "System Audio Recording
/// Only" lists the apps allowed to use a process tap.
pub(crate) fn open_system_audio_privacy_settings() -> Result<(), String> {
    if open_privacy_settings("Privacy_AudioCapture") {
        Ok(())
    } else {
        Err("Could not open System Settings".to_string())
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
        PermissionState::Denied
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

        let mut final_trusted = AXIsProcessTrusted();
        log::debug!(
            "request_accessibility_permission final_trusted={}",
            final_trusted
        );

        if !final_trusted {
            let settings_opened = open_accessibility_privacy_settings();
            log::debug!(
                "Accessibility settings opened via helper={}",
                settings_opened
            );
            if settings_opened {
                final_trusted = AXIsProcessTrusted();
                log::debug!(
                    "request_accessibility_permission final_trusted_after_settings={}",
                    final_trusted
                );
            }
            prompt_shown |= settings_opened;
        }

        Ok(PermissionStatus {
            kind: PermissionKind::Accessibility,
            state: accessibility_state_from_bool(final_trusted),
            prompt_shown,
        })
    }
}
