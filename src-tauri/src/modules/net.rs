use std::time::Duration;

#[tauri::command]
pub async fn http_ping(url: String, auth: Option<String>) -> Result<u16, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(&url);
    if let Some(token) = auth.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        req = req.bearer_auth(token);
    }
    req.send()
        .await
        .map(|r| r.status().as_u16())
        .map_err(|e| e.to_string())
}
