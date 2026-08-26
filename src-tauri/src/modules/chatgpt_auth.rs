//! Sign in to TEDI with a ChatGPT account instead of an API key.
//!
//! OAuth 2.0 authorization-code + PKCE against `auth.openai.com`, with the
//! loopback redirect the OpenAI public client accepts. Afterwards the tokens
//! address the ChatGPT backend's Responses endpoint, so a ChatGPT Plus/Pro
//! subscription is what pays for a turn rather than API credits.
//!
//! Why this lives in Rust and not the webview:
//!   - the redirect target must be a real listener on `127.0.0.1:1455`, and the
//!     webview cannot bind a socket;
//!   - the token exchange has no CORS headers, so a webview `fetch` is blocked;
//!   - the refresh token is a long-lived credential and belongs nowhere near
//!     page-accessible storage (the TS side puts it straight in the OS keychain).
//!
//! No new dependency: `ring` supplies the CSPRNG, `sha2` the S256 challenge,
//! `base64` the URL-safe encoding, and `tokio::net` the one-shot listener.
//!
//! This targets an endpoint OpenAI documents for its own client, not a public
//! API. It can change without notice; every failure path below reports what
//! actually went wrong rather than collapsing to "login failed".

use std::time::Duration;

use base64::Engine;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// OpenAI's public client for the Codex CLI. Public client, so no secret: PKCE
/// is what binds the authorization code to this process.
const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
/// The one loopback callback the client allows. The port is not ours to pick.
const REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
const CALLBACK_ADDR: &str = "127.0.0.1:1455";
const SCOPE: &str = "openid profile email offline_access";
/// How long the listener waits for the browser round trip before giving up.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

/// Emitted once the authorize URL exists, so the UI can offer a copyable link
/// when the system browser refuses to open.
const EVENT_URL: &str = "chatgpt-auth-url";

#[derive(Serialize, Clone)]
pub struct ChatGptTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub id_token: String,
    /// Unix seconds. Absolute, not a duration, so the TS side can compare it to
    /// `Date.now()` without tracking when the exchange happened.
    pub expires_at: i64,
    /// From the id_token's OpenAI claims. Sent as `chatgpt-account-id`; the
    /// backend rejects a request without it.
    pub account_id: Option<String>,
    pub email: Option<String>,
    pub plan: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_b64(len: usize) -> Result<String, String> {
    let mut buf = vec![0u8; len];
    SystemRandom::new()
        .fill(&mut buf)
        .map_err(|_| "could not read the system random source".to_string())?;
    Ok(b64url(&buf))
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Percent-encode one query value. `url::form_urlencoded` is already in the
/// tree via `url`, and hand-rolling this is exactly how a stray `+` or `/`
/// silently corrupts a PKCE challenge.
fn query(pairs: &[(&str, &str)]) -> String {
    let mut ser = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in pairs {
        ser.append_pair(k, v);
    }
    ser.finish()
}

/// Decode a JWT's payload without verifying it.
///
/// Verification is the token endpoint's job: this id_token arrived over TLS as
/// the direct response to our own PKCE-bound exchange, and nothing security
/// relevant is decided from these claims - they only populate the account id
/// header and the "signed in as" line.
fn jwt_claims(token: &str) -> Option<serde_json::Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Pull the ChatGPT account id out of the id_token.
///
/// The claim is namespaced and OpenAI has moved it before, so this walks a list
/// of known homes and then falls back to a shallow search for any
/// `chatgpt_account_id` key. A miss is not fatal here: the caller surfaces it,
/// and the request simply goes out without the header so the failure is a clear
/// server-side 401 rather than a silent wrong-account call.
fn account_id_of(claims: &serde_json::Value) -> Option<String> {
    let direct = claims
        .get("https://api.openai.com/auth")
        .and_then(|a| a.get("chatgpt_account_id"))
        .or_else(|| claims.get("chatgpt_account_id"))
        .or_else(|| {
            claims
                .get("https://api.openai.com/profile")
                .and_then(|a| a.get("chatgpt_account_id"))
        });
    if let Some(v) = direct.and_then(|v| v.as_str()) {
        return Some(v.to_string());
    }
    // Fallback: one level down any object claim.
    if let Some(obj) = claims.as_object() {
        for value in obj.values() {
            if let Some(inner) = value.as_object() {
                if let Some(v) = inner.get("chatgpt_account_id").and_then(|v| v.as_str()) {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

fn plan_of(claims: &serde_json::Value) -> Option<String> {
    claims
        .get("https://api.openai.com/auth")
        .and_then(|a| a.get("chatgpt_plan_type"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn tokens_from(resp: TokenResponse, fallback_refresh: Option<String>) -> ChatGptTokens {
    let claims = resp.id_token.as_deref().and_then(jwt_claims);
    ChatGptTokens {
        expires_at: now_secs() + resp.expires_in.unwrap_or(3600),
        account_id: claims.as_ref().and_then(account_id_of),
        email: claims
            .as_ref()
            .and_then(|c| c.get("email"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        plan: claims.as_ref().and_then(plan_of),
        // A refresh response may omit the refresh token, meaning "keep the one
        // you have". Dropping it there would sign the user out an hour later.
        refresh_token: resp.refresh_token.or(fallback_refresh).unwrap_or_default(),
        id_token: resp.id_token.unwrap_or_default(),
        access_token: resp.access_token,
    }
}

async fn post_token(form: String) -> Result<TokenResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let res = client
        .post(TOKEN_URL)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(form)
        .send()
        .await
        .map_err(|e| format!("token request failed: {e}"))?;
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        // Carry the server's own words: "invalid_grant" and "unsupported scope"
        // need completely different fixes and both arrive as a 400.
        return Err(format!("token endpoint returned {status}: {body}"));
    }
    serde_json::from_str::<TokenResponse>(&body)
        .map_err(|e| format!("could not parse the token response: {e}"))
}

/// Read the request line of one HTTP request and answer it.
///
/// Deliberately not a real HTTP server: it accepts exactly one request, reads
/// only up to the end of the headers, and closes. `read_buf` is capped so a
/// stray connection cannot grow it without bound.
async fn accept_callback(listener: &TcpListener) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|e| format!("callback accept failed: {e}"))?;

        let mut buf = Vec::with_capacity(2048);
        let mut chunk = [0u8; 1024];
        let target = loop {
            let n = match stream.read(&mut chunk).await {
                Ok(0) => break None,
                Ok(n) => n,
                Err(e) => return Err(format!("callback read failed: {e}")),
            };
            buf.extend_from_slice(&chunk[..n]);
            if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 16 * 1024 {
                let text = String::from_utf8_lossy(&buf).to_string();
                break text
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .map(|s| s.to_string());
            }
        };

        let Some(target) = target else {
            continue; // a probe that sent nothing; keep waiting for the browser
        };
        // The browser also asks for /favicon.ico. Answer it and keep listening,
        // or that request would be mistaken for the callback.
        if !target.starts_with("/auth/callback") {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n").await;
            let _ = stream.shutdown().await;
            continue;
        }

        let body = "<!doctype html><meta charset=utf-8><title>TEDI</title>\
<body style=\"font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#0a0a0a;color:#ededed\">\
<div style=\"text-align:center\"><p style=\"font-size:22px;margin:0 0 6px\">Signed in to TEDI</p>\
<p style=\"opacity:.6;margin:0\">You can close this tab and go back to the app.</p></div>";
        let _ = stream
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .as_bytes(),
            )
            .await;
        let _ = stream.shutdown().await;
        return Ok(target);
    }
}

/// Run the whole browser sign-in and return the tokens.
///
/// One command rather than start/poll: the listener, the PKCE verifier and the
/// state all belong to a single attempt, and keeping them on the stack means
/// there is no half-open login to clean up if the user closes the dialog.
#[tauri::command]
pub async fn chatgpt_auth_login(app: tauri::AppHandle) -> Result<ChatGptTokens, String> {
    let verifier = random_b64(32)?;
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let state = random_b64(16)?;

    // Bind BEFORE opening the browser: if the port is taken (another Codex-style
    // client mid-login), the user must hear that now, not after authenticating.
    let listener = TcpListener::bind(CALLBACK_ADDR).await.map_err(|e| {
        format!(
            "could not listen on {CALLBACK_ADDR} ({e}). OpenAI only accepts this exact \
             callback address, so close whatever is using port 1455 and try again."
        )
    })?;

    let auth_url = format!(
        "{AUTHORIZE_URL}?{}",
        query(&[
            ("response_type", "code"),
            ("client_id", CLIENT_ID),
            ("redirect_uri", REDIRECT_URI),
            ("scope", SCOPE),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("state", &state),
            ("id_token_add_organizations", "true"),
            ("codex_cli_simplified_flow", "true"),
        ])
    );

    // Emit before opening so the UI can show the link even if the open fails.
    let _ = app.emit(EVENT_URL, auth_url.clone());
    if let Err(e) = tauri_plugin_opener::open_url(auth_url.clone(), None::<&str>) {
        // Not fatal: the URL is already in the UI and the listener is up.
        log::warn!("[chatgpt-auth] could not open the browser: {e}");
    }

    let target = tokio::time::timeout(LOGIN_TIMEOUT, accept_callback(&listener))
        .await
        .map_err(|_| "timed out waiting for the browser sign-in".to_string())??;

    // Parse `?code=...&state=...` off the request target.
    let parsed = url::Url::parse(&format!("http://localhost{target}"))
        .map_err(|e| format!("could not parse the callback: {e}"))?;
    let mut code = None;
    let mut got_state = None;
    let mut err = None;
    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => got_state = Some(v.into_owned()),
            "error_description" | "error" => {
                err.get_or_insert(v.into_owned());
            }
            _ => continue,
        };
    }
    if let Some(e) = err {
        return Err(format!("sign-in was refused: {e}"));
    }
    // CSRF: the code is only ours if the state came back unchanged.
    if got_state.as_deref() != Some(state.as_str()) {
        return Err("the callback state did not match; sign-in was abandoned".to_string());
    }
    let code = code.ok_or_else(|| "the callback carried no authorization code".to_string())?;

    let resp = post_token(query(&[
        ("grant_type", "authorization_code"),
        ("code", &code),
        ("redirect_uri", REDIRECT_URI),
        ("client_id", CLIENT_ID),
        ("code_verifier", &verifier),
    ]))
    .await?;
    Ok(tokens_from(resp, None))
}

/// Trade a refresh token for a fresh access token. Called by the TS side when
/// the stored `expires_at` is close, so a long session never 401s mid-turn.
#[tauri::command]
pub async fn chatgpt_auth_refresh(refresh_token: String) -> Result<ChatGptTokens, String> {
    if refresh_token.trim().is_empty() {
        return Err("no refresh token stored; sign in again".to_string());
    }
    let resp = post_token(query(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", &refresh_token),
        ("client_id", CLIENT_ID),
        ("scope", SCOPE),
    ]))
    .await?;
    Ok(tokens_from(resp, Some(refresh_token)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt_with(payload: serde_json::Value) -> String {
        format!("h.{}.s", b64url(payload.to_string().as_bytes()))
    }

    #[test]
    fn pkce_challenge_is_s256_base64url_unpadded() {
        // RFC 7636 appendix B's vector: the verifier below must produce exactly
        // this challenge, or the token exchange fails with invalid_grant and
        // nothing else in the flow tells you why.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        assert!(!challenge.contains('='), "must be unpadded");
        assert!(!challenge.contains('+') && !challenge.contains('/'), "must be url-safe");
    }

    #[test]
    fn account_id_is_found_in_every_known_claim_home() {
        let namespaced = jwt_with(serde_json::json!({
            "https://api.openai.com/auth": { "chatgpt_account_id": "acct-ns" }
        }));
        assert_eq!(
            account_id_of(&jwt_claims(&namespaced).unwrap()),
            Some("acct-ns".into())
        );

        let flat = jwt_with(serde_json::json!({ "chatgpt_account_id": "acct-flat" }));
        assert_eq!(
            account_id_of(&jwt_claims(&flat).unwrap()),
            Some("acct-flat".into())
        );

        // A claim OpenAI moves somewhere new must still be found, or a rename
        // silently signs everyone out.
        let moved = jwt_with(serde_json::json!({
            "https://api.openai.com/something_new": { "chatgpt_account_id": "acct-moved" }
        }));
        assert_eq!(
            account_id_of(&jwt_claims(&moved).unwrap()),
            Some("acct-moved".into())
        );

        let none = jwt_with(serde_json::json!({ "email": "a@b.c" }));
        assert_eq!(account_id_of(&jwt_claims(&none).unwrap()), None);
    }

    #[test]
    fn a_refresh_without_a_new_refresh_token_keeps_the_old_one() {
        // The endpoint may omit it, meaning "keep yours". Dropping it here
        // signed the user out an hour later, which reads as a random failure.
        let resp = TokenResponse {
            access_token: "at".into(),
            refresh_token: None,
            id_token: None,
            expires_in: Some(60),
        };
        let out = tokens_from(resp, Some("old-rt".into()));
        assert_eq!(out.refresh_token, "old-rt");
        assert!(out.expires_at >= now_secs());
    }

    #[test]
    fn query_escapes_values_that_would_corrupt_the_challenge() {
        // A challenge is base64url so it never needs escaping, but `state` and
        // an error description do; a hand-rolled join would ship a broken URL.
        let q = query(&[("a", "x y"), ("b", "p+q/r=")]);
        assert_eq!(q, "a=x+y&b=p%2Bq%2Fr%3D");
    }
}
