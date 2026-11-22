use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use rand::{rngs::OsRng, RngCore};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{self, Read, Write},
    net::{TcpListener, TcpStream},
    thread::sleep,
    time::{Duration, Instant},
};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use url::{form_urlencoded, Url};

use crate::state::oauth::GoogleOAuthConfig;

pub const GOOGLE_AUTH_EVENT: &str = "voquill:google-auth";

const AUTHORIZATION_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const CERTS_URL: &str = "https://www.googleapis.com/oauth2/v3/certs";
const CALLBACK_PATH: &str = "/callback";
const HTTP_SERVER_TIMEOUT: Duration = Duration::from_secs(120);
const HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub const SIGN_IN_SCOPES: &str = "openid email profile";
pub const CALENDAR_SCOPES: [&str; 2] = [
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events.readonly",
];

#[derive(Debug, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GoogleAuthEventPayload {
    pub id_token: String,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: i64,
    pub token_type: String,
    pub user: GoogleUserInfo,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GoogleUserInfo {
    pub sub: String,
    pub email: Option<String>,
    pub name: Option<String>,
    pub picture: Option<String>,
}

pub struct GoogleAuthFlowResult {
    pub payload: GoogleAuthEventPayload,
    pub refresh_token: Option<String>,
    pub granted_scopes: Vec<String>,
}

pub struct RefreshedAccessToken {
    pub access_token: String,
    pub expires_in: i64,
}

pub enum RefreshError {
    /// The refresh token was revoked or expired; the user has to link again.
    Revoked,
    Other(String),
}

pub async fn start_google_oauth(
    app_handle: &AppHandle,
    config: &GoogleOAuthConfig,
    scopes: &str,
) -> Result<GoogleAuthFlowResult, String> {
    let code_verifier = generate_code_verifier();
    let code_challenge = compute_code_challenge(&code_verifier);
    let state = random_string(32);
    let server_state = state.clone();

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|err| format!("Failed to bind OAuth callback listener: {err}"))?;

    let port = listener
        .local_addr()
        .map_err(|err| format!("Unable to read OAuth listener port: {err}"))?
        .port();

    let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");

    let server_handle = tauri::async_runtime::spawn_blocking(move || {
        run_local_http_server(listener, server_state, HTTP_SERVER_TIMEOUT)
    });

    let auth_url = build_authorization_url(
        &config.client_id,
        &redirect_uri,
        &code_challenge,
        &state,
        scopes,
    );

    if let Err(err) = app_handle
        .opener()
        .open_url(auth_url, Option::<String>::None)
    {
        log::error!("Failed to open browser for Google OAuth flow: {err}");
    }

    let authorization_code = server_handle
        .await
        .map_err(|err| format!("OAuth listener panicked: {err}"))?
        .map_err(|err| format!("OAuth listener failed: {err}"))?;

    let client = http_client()?;

    let token_response = exchange_code_for_tokens(
        &client,
        config,
        &authorization_code,
        &code_verifier,
        &redirect_uri,
    )
    .await?;

    let claims = verify_id_token(&client, &token_response.id_token, config).await?;

    let user = GoogleUserInfo {
        sub: claims.sub,
        email: claims.email,
        name: claims.name,
        picture: claims.picture,
    };

    let payload = GoogleAuthEventPayload {
        id_token: token_response.id_token.clone(),
        access_token: token_response.access_token.clone(),
        refresh_token: token_response.refresh_token.clone(),
        expires_in: token_response.expires_in,
        token_type: token_response.token_type.clone(),
        user,
    };

    Ok(GoogleAuthFlowResult {
        payload,
        refresh_token: token_response.refresh_token,
        granted_scopes: token_response
            .scope
            .split_whitespace()
            .map(str::to_owned)
            .collect(),
    })
}

pub async fn refresh_access_token(
    config: &GoogleOAuthConfig,
    refresh_token: &str,
) -> Result<RefreshedAccessToken, RefreshError> {
    let response = http_client()
        .map_err(RefreshError::Other)?
        .post(TOKEN_URL)
        .form(&[
            ("client_id", config.client_id.as_str()),
            ("client_secret", config.client_secret.as_str()),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|err| RefreshError::Other(format!("Failed to refresh Google token: {err}")))?;

    let status = response.status();
    if !status.is_success() {
        let error = response
            .json::<TokenErrorResponse>()
            .await
            .map(|body| body.error)
            .unwrap_or_default();
        return Err(if error == "invalid_grant" {
            RefreshError::Revoked
        } else {
            RefreshError::Other(format!(
                "Google token endpoint responded with status {status}"
            ))
        });
    }

    let body = response
        .json::<RefreshResponse>()
        .await
        .map_err(|err| RefreshError::Other(format!("Failed to decode Google token: {err}")))?;

    Ok(RefreshedAccessToken {
        access_token: body.access_token,
        expires_in: body.expires_in,
    })
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .user_agent("voquill-desktop")
        .timeout(HTTP_REQUEST_TIMEOUT)
        .build()
        .map_err(|err| format!("Failed to build HTTP client: {err}"))
}

fn generate_code_verifier() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn compute_code_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

fn random_string(length: usize) -> String {
    let mut bytes = vec![0u8; length];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn build_authorization_url(
    client_id: &str,
    redirect_uri: &str,
    code_challenge: &str,
    state: &str,
    scopes: &str,
) -> String {
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", scopes)
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent")
        .finish();

    format!("{AUTHORIZATION_URL}?{query}")
}

fn run_local_http_server(
    listener: TcpListener,
    expected_state: String,
    timeout: Duration,
) -> Result<String, String> {
    listener
        .set_nonblocking(true)
        .map_err(|err| format!("OAuth listener configuration failure: {err}"))?;

    let start = Instant::now();
    while Instant::now().duration_since(start) < timeout {
        match listener.accept() {
            Ok((mut stream, _)) => match handle_request(&mut stream, &expected_state) {
                Ok(Some(code)) => return Ok(code),
                Ok(None) => continue,
                Err(err) => return Err(err),
            },
            Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                sleep(Duration::from_millis(50));
                continue;
            }
            Err(err) => return Err(format!("OAuth listener failed: {err}")),
        }
    }

    Err("Timed out waiting for Google authentication".to_string())
}

fn handle_request(stream: &mut TcpStream, expected_state: &str) -> Result<Option<String>, String> {
    let mut buffer = [0u8; 4096];
    let bytes_read = stream
        .read(&mut buffer)
        .map_err(|err| format!("Failed to read OAuth callback request: {err}"))?;

    if bytes_read == 0 {
        return Err("Received empty OAuth callback request".to_string());
    }

    let request = std::str::from_utf8(&buffer[..bytes_read])
        .map_err(|err| format!("Invalid OAuth callback payload: {err}"))?;

    let mut lines = request.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| "Malformed OAuth callback request".to_string())?;

    let mut parts = request_line.split_whitespace();
    let _method = parts
        .next()
        .ok_or_else(|| "Malformed OAuth request line".to_string())?;
    let raw_path = parts
        .next()
        .ok_or_else(|| "Malformed OAuth request line".to_string())?;

    let full_url = format!("http://localhost{raw_path}");
    let parsed = Url::parse(&full_url)
        .map_err(|err| format!("Failed to parse OAuth callback URL: {err}"))?;

    if parsed.path() != CALLBACK_PATH {
        respond(stream, 404, "Not found")?;
        return Ok(None);
    }

    let query: HashMap<_, _> = parsed.query_pairs().into_owned().collect();
    let state = query.get("state");
    let code = query.get("code");

    if state.map(|value| value.as_str()) != Some(expected_state) {
        respond(stream, 400, "Invalid sign-in request")?;
        return Ok(None);
    }

    if let Some(error) = query.get("error") {
        respond(
            stream,
            400,
            "Google access was not granted. You can close this tab.",
        )?;
        return Err(format!("Google authorization was not granted: {error}"));
    }

    if code.is_none() {
        respond(stream, 400, "Invalid sign-in request")?;
        return Ok(None);
    }

    respond(stream, 200, super::oauth_callback_page::success_html())?;
    Ok(Some(code.unwrap().clone()))
}

fn respond(stream: &mut TcpStream, status: u16, body: &str) -> Result<(), String> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "OK",
    };

    let response = format!(
		"HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n{body}",
		body.len(),
	);

    stream
        .write_all(response.as_bytes())
        .map_err(|err| format!("Failed to send OAuth response: {err}"))
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: i64,
    refresh_token: Option<String>,
    scope: String,
    token_type: String,
    id_token: String,
}

#[derive(Debug, Deserialize)]
struct RefreshResponse {
    access_token: String,
    expires_in: i64,
}

#[derive(Debug, Default, Deserialize)]
struct TokenErrorResponse {
    error: String,
}

#[derive(Debug, Deserialize)]
struct GoogleJwk {
    kid: String,
    n: String,
    e: String,
}

#[derive(Debug, Deserialize)]
struct GoogleJwks {
    keys: Vec<GoogleJwk>,
}

async fn exchange_code_for_tokens(
    client: &Client,
    config: &GoogleOAuthConfig,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<TokenResponse, String> {
    let response = client
        .post(TOKEN_URL)
        .form(&[
            ("code", code),
            ("client_id", &config.client_id),
            ("client_secret", &config.client_secret),
            ("redirect_uri", redirect_uri),
            ("grant_type", "authorization_code"),
            ("code_verifier", code_verifier),
        ])
        .send()
        .await
        .map_err(|err| format!("Failed to request Google tokens: {err}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Google token endpoint responded with status {}",
            response.status()
        ));
    }

    response
        .json::<TokenResponse>()
        .await
        .map_err(|err| format!("Failed to decode Google token response: {err}"))
}

async fn verify_id_token(
    client: &Client,
    id_token: &str,
    config: &GoogleOAuthConfig,
) -> Result<GoogleIdTokenClaims, String> {
    let header =
        decode_header(id_token).map_err(|err| format!("Failed to read ID token header: {err}"))?;

    let kid = header
        .kid
        .ok_or_else(|| "ID token missing kid header".to_string())?;

    let jwks = client
        .get(CERTS_URL)
        .send()
        .await
        .map_err(|err| format!("Failed to download Google certs: {err}"))?
        .json::<GoogleJwks>()
        .await
        .map_err(|err| format!("Failed to parse Google certs: {err}"))?;

    let jwk = jwks
        .keys
        .into_iter()
        .find(|key| key.kid == kid)
        .ok_or_else(|| "Unable to find matching Google signing key".to_string())?;

    let decoding_key = DecodingKey::from_rsa_components(&jwk.n, &jwk.e)
        .map_err(|err| format!("Failed to decode Google signing key: {err}"))?;

    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[config.client_id.as_str()]);

    let token_data = decode::<GoogleIdTokenClaims>(id_token, &decoding_key, &validation)
        .map_err(|err| format!("Failed to verify Google ID token; {err}"))?;

    let claims = token_data.claims;

    if claims.iss != "https://accounts.google.com" && claims.iss != "accounts.google.com" {
        return Err("Google ID token has unexpected issuer".to_string());
    }

    Ok(claims)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleIdTokenClaims {
    iss: String,
    sub: String,
    #[serde(rename = "aud")]
    _aud: Audience,
    #[serde(rename = "exp")]
    _exp: i64,
    email: Option<String>,
    name: Option<String>,
    picture: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Audience {
    Single(#[allow(dead_code)] String),
    Multiple(#[allow(dead_code)] Vec<String>),
}
