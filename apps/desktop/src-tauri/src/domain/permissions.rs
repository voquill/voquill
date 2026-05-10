use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionState {
    Authorized,
    Denied,
    Restricted,
    NotDetermined,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionKind {
    Microphone,
    Accessibility,
    ScreenRecording,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PermissionStatus {
    pub kind: PermissionKind,
    pub state: PermissionState,
    pub prompt_shown: bool,
}
