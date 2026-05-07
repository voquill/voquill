use std::env;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;
use url::Url;

use crate::system::crypto::{protect_api_key, reveal_api_key};

const SESSION_FILE_NAME: &str = "auth_session.json";
const ID_TOKEN_SKEW_SECONDS: i64 = 30;

#[derive(Debug, thiserror::Error)]
pub enum AuthSessionError {
    #[error("missing firebase configuration: {0}")]
    MissingConfig(&'static str),
    #[error("not signed in")]
    NotSignedIn,
    #[error("network error: {0}")]
    Network(String),
    #[error("firebase error: {0}")]
    Firebase(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("crypto error: {0}")]
    Crypto(String),
    #[error("serde error: {0}")]
    Serde(String),
}

impl AuthSessionError {
    pub fn to_user_string(&self) -> String {
        self.to_string()
    }
}

fn read_flavor_env(key: &str) -> Option<String> {
    let compile_time = match key {
        "VITE_FIREBASE_API_KEY" => option_env!("VITE_FIREBASE_API_KEY"),
        "VITE_FIREBASE_PROJECT_ID" => option_env!("VITE_FIREBASE_PROJECT_ID"),
        "VITE_FLAVOR" => option_env!("VITE_FLAVOR"),
        "VITE_USE_EMULATORS" => option_env!("VITE_USE_EMULATORS"),
        _ => None,
    };
    compile_time
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            env::var(key)
                .ok()
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty())
        })
}

impl From<io::Error> for AuthSessionError {
    fn from(err: io::Error) -> Self {
        AuthSessionError::Io(err.to_string())
    }
}

impl From<serde_json::Error> for AuthSessionError {
    fn from(err: serde_json::Error) -> Self {
        AuthSessionError::Serde(err.to_string())
    }
}

impl From<reqwest::Error> for AuthSessionError {
    fn from(err: reqwest::Error) -> Self {
        AuthSessionError::Network(err.to_string())
    }
}

#[derive(Clone, Debug)]
pub struct FirebaseConfig {
    pub api_key: String,
    pub project_id: String,
    pub use_emulators: bool,
}

impl FirebaseConfig {
    pub fn from_env() -> Result<Self, AuthSessionError> {
        let api_key = read_flavor_env("VITE_FIREBASE_API_KEY")
            .ok_or(AuthSessionError::MissingConfig("VITE_FIREBASE_API_KEY"))?;
        let project_id = read_flavor_env("VITE_FIREBASE_PROJECT_ID")
            .ok_or(AuthSessionError::MissingConfig("VITE_FIREBASE_PROJECT_ID"))?;
        let flavor = read_flavor_env("VITE_FLAVOR").unwrap_or_else(|| "dev".to_string());
        let use_emulators_flag = read_flavor_env("VITE_USE_EMULATORS")
            .map(|value| value.trim().eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        let use_emulators = flavor == "emulators" || (flavor == "dev" && use_emulators_flag);
        Ok(Self {
            api_key,
            project_id,
            use_emulators,
        })
    }

    fn identity_toolkit_base(&self) -> String {
        if self.use_emulators {
            "http://localhost:9099/identitytoolkit.googleapis.com/v1".to_string()
        } else {
            "https://identitytoolkit.googleapis.com/v1".to_string()
        }
    }

    fn secure_token_base(&self) -> String {
        if self.use_emulators {
            "http://localhost:9099/securetoken.googleapis.com/v1".to_string()
        } else {
            "https://securetoken.googleapis.com/v1".to_string()
        }
    }

    fn functions_handler_url(&self) -> String {
        if self.use_emulators {
            format!(
                "http://localhost:5001/{}/us-central1/handler",
                self.project_id
            )
        } else {
            format!(
                "https://us-central1-{}.cloudfunctions.net/handler",
                self.project_id
            )
        }
    }
}

#[derive(Serialize, Deserialize)]
struct PersistedSession {
    salt_b64: String,
    refresh_token_ciphertext_b64: String,
}

#[derive(Clone, Debug)]
struct IdTokenCache {
    id_token: String,
    expires_at_unix: i64,
}

struct Inner {
    session_path: PathBuf,
    config: FirebaseConfig,
    refresh_token: Option<String>,
    id_token: Option<IdTokenCache>,
    client: Client,
}

#[derive(Clone)]
pub struct AuthSession {
    inner: Arc<Mutex<Inner>>,
}

impl AuthSession {
    pub fn new(app: &AppHandle) -> Result<Self, AuthSessionError> {
        let session_path = session_file_path(app)?;
        let config = FirebaseConfig::from_env()?;
        let refresh_token = match load_refresh_token(&session_path) {
            Ok(value) => value,
            Err(err) => {
                log::warn!("failed to load persisted auth session: {err}; starting fresh");
                None
            }
        };
        let client = Client::builder()
            .user_agent("voquill-desktop")
            .build()
            .map_err(|err| AuthSessionError::Network(err.to_string()))?;
        Ok(Self {
            inner: Arc::new(Mutex::new(Inner {
                session_path,
                config,
                refresh_token,
                id_token: None,
                client,
            })),
        })
    }

    pub async fn sign_in_with_custom_token(
        &self,
        custom_token: &str,
    ) -> Result<(), AuthSessionError> {
        let mut guard = self.inner.lock().await;
        let response =
            sign_in_with_custom_token(&guard.client, &guard.config, custom_token).await?;
        persist_refresh_token(&guard.session_path, &response.refresh_token)?;
        guard.refresh_token = Some(response.refresh_token);
        guard.id_token = Some(IdTokenCache {
            id_token: response.id_token,
            expires_at_unix: now_unix() + parse_expires_in(&response.expires_in),
        });
        Ok(())
    }

    pub async fn mint_custom_token(&self) -> Result<String, AuthSessionError> {
        let mut guard = self.inner.lock().await;
        let id_token = ensure_fresh_id_token(&mut guard).await?;
        let url = guard.config.functions_handler_url();
        let body = serde_json::json!({ "data": { "name": "auth/mintCustomToken", "args": {} } });
        let response = guard
            .client
            .post(&url)
            .bearer_auth(&id_token)
            .json(&body)
            .send()
            .await?;
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(AuthSessionError::Firebase(format!(
                "mintCustomToken failed ({status}): {text}"
            )));
        }
        let payload: HandlerEnvelope<MintCustomTokenResult> = response.json().await?;
        Ok(payload.result.custom_token)
    }

    pub async fn sign_out(&self, app: &AppHandle) -> Result<(), AuthSessionError> {
        let mut guard = self.inner.lock().await;
        guard.refresh_token = None;
        guard.id_token = None;
        if guard.session_path.exists() {
            fs::remove_file(&guard.session_path)?;
        }
        drop(guard);
        if let Err(err) = navigate_main_to_built_in(app) {
            log::warn!("auth_sign_out: failed to navigate main webview home: {err}");
        }
        Ok(())
    }

    pub async fn is_signed_in(&self) -> Result<bool, AuthSessionError> {
        let mut guard = self.inner.lock().await;
        if guard.refresh_token.is_none() {
            return Ok(false);
        }
        match refresh_id_token(&mut guard).await {
            Ok(()) => Ok(true),
            Err(AuthSessionError::NotSignedIn) => {
                clear_session(&mut guard)?;
                Ok(false)
            }
            Err(AuthSessionError::Firebase(msg)) => {
                log::warn!(
                    "auth_is_signed_in: firebase rejected refresh ({msg}); clearing session"
                );
                clear_session(&mut guard)?;
                Ok(false)
            }
            Err(err) => Err(err),
        }
    }
}

fn clear_session(guard: &mut Inner) -> Result<(), AuthSessionError> {
    guard.refresh_token = None;
    guard.id_token = None;
    if guard.session_path.exists() {
        fs::remove_file(&guard.session_path)?;
    }
    Ok(())
}

async fn ensure_fresh_id_token(guard: &mut Inner) -> Result<String, AuthSessionError> {
    if let Some(cache) = guard.id_token.as_ref() {
        if cache.expires_at_unix - ID_TOKEN_SKEW_SECONDS > now_unix() {
            return Ok(cache.id_token.clone());
        }
    }
    refresh_id_token(guard).await?;
    guard
        .id_token
        .as_ref()
        .map(|cache| cache.id_token.clone())
        .ok_or(AuthSessionError::NotSignedIn)
}

async fn refresh_id_token(guard: &mut Inner) -> Result<(), AuthSessionError> {
    let refresh_token = guard
        .refresh_token
        .clone()
        .ok_or(AuthSessionError::NotSignedIn)?;
    let url = format!(
        "{}/token?key={}",
        guard.config.secure_token_base(),
        guard.config.api_key
    );
    let form = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token.as_str()),
    ];
    let response = guard.client.post(&url).form(&form).send().await?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        if status == reqwest::StatusCode::BAD_REQUEST
            || status == reqwest::StatusCode::UNAUTHORIZED
            || status == reqwest::StatusCode::FORBIDDEN
        {
            return Err(AuthSessionError::Firebase(format!(
                "refresh rejected ({status}): {text}"
            )));
        }
        return Err(AuthSessionError::Network(format!(
            "refresh failed ({status}): {text}"
        )));
    }
    let payload: SecureTokenResponse = response.json().await?;
    let new_refresh = payload.refresh_token.unwrap_or(refresh_token);
    if guard.refresh_token.as_deref() != Some(new_refresh.as_str()) {
        persist_refresh_token(&guard.session_path, &new_refresh)?;
        guard.refresh_token = Some(new_refresh);
    }
    guard.id_token = Some(IdTokenCache {
        id_token: payload.id_token,
        expires_at_unix: now_unix() + parse_expires_in(&payload.expires_in),
    });
    Ok(())
}

async fn sign_in_with_custom_token(
    client: &Client,
    config: &FirebaseConfig,
    custom_token: &str,
) -> Result<SignInWithCustomTokenResponse, AuthSessionError> {
    let url = format!(
        "{}/accounts:signInWithCustomToken?key={}",
        config.identity_toolkit_base(),
        config.api_key
    );
    let body = serde_json::json!({ "token": custom_token, "returnSecureToken": true });
    let response = client.post(&url).json(&body).send().await?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(AuthSessionError::Firebase(format!(
            "signInWithCustomToken failed ({status}): {text}"
        )));
    }
    let parsed: SignInWithCustomTokenResponse = response.json().await?;
    Ok(parsed)
}

pub(crate) fn navigate_main_to_built_in(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main webview not available".to_string())?;
    let url = built_in_url(app)?.to_string();
    let url_json =
        serde_json::to_string(&url).map_err(|err| format!("serialize built-in url: {err}"))?;
    let script = format!("window.location.replace({url_json});");
    window
        .eval(&script)
        .map_err(|err| format!("navigate failed: {err}"))
}

fn built_in_url(app: &AppHandle) -> Result<Url, String> {
    #[cfg(debug_assertions)]
    if let Some(dev_url) = app.config().build.dev_url.as_ref() {
        return Ok(dev_url.clone());
    }
    #[cfg(not(debug_assertions))]
    let _ = app;
    let fallback = if cfg!(target_os = "windows") {
        "http://tauri.localhost/index.html"
    } else {
        "tauri://localhost/index.html"
    };
    Url::parse(fallback).map_err(|err| err.to_string())
}

fn session_file_path(app: &AppHandle) -> Result<PathBuf, AuthSessionError> {
    let mut path = app
        .path()
        .app_config_dir()
        .map_err(|err| AuthSessionError::Io(err.to_string()))?;
    fs::create_dir_all(&path)?;
    path.push(SESSION_FILE_NAME);
    Ok(path)
}

fn load_refresh_token(path: &PathBuf) -> Result<Option<String>, AuthSessionError> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path)?;
    let persisted: PersistedSession = serde_json::from_slice(&bytes)?;
    let plaintext = reveal_api_key(&persisted.salt_b64, &persisted.refresh_token_ciphertext_b64)
        .map_err(|err| AuthSessionError::Crypto(err.to_string()))?;
    Ok(Some(plaintext))
}

fn persist_refresh_token(path: &PathBuf, refresh_token: &str) -> Result<(), AuthSessionError> {
    let protected = protect_api_key(refresh_token);
    let persisted = PersistedSession {
        salt_b64: protected.salt_b64,
        refresh_token_ciphertext_b64: protected.ciphertext_b64,
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec(&persisted)?;
    fs::write(path, bytes)?;
    Ok(())
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn parse_expires_in(raw: &str) -> i64 {
    raw.parse::<i64>().unwrap_or(3600)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignInWithCustomTokenResponse {
    id_token: String,
    refresh_token: String,
    expires_in: String,
}

#[derive(Deserialize)]
struct SecureTokenResponse {
    id_token: String,
    refresh_token: Option<String>,
    expires_in: String,
}

#[derive(Deserialize)]
struct HandlerEnvelope<T> {
    result: T,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MintCustomTokenResult {
    custom_token: String,
}
