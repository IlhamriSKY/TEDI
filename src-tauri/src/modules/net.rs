use std::sync::OnceLock;
use std::time::Duration;

// Shared HTTP client. Rebuilding per `http_ping` defeats reqwest's connection
// pool; the preview pill polls on a short interval, so each call would pay
// the TLS handshake cost.
static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("http_ping client init")
    })
}

#[tauri::command]
pub async fn http_ping(url: String, auth: Option<String>) -> Result<u16, String> {
    let mut req = client().get(&url);
    if let Some(token) = auth.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        req = req.bearer_auth(token);
    }
    req.send()
        .await
        .map(|r| r.status().as_u16())
        .map_err(|e| e.to_string())
}
