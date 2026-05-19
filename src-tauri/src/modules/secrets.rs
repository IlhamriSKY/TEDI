//! Secret storage with platform-appropriate backends.
//!
//! - macOS: macOS Keychain (via `keyring` crate). No relevant size limit.
//! - Windows: a DPAPI-encrypted file in the app's local data dir.
//!   Earlier builds used the Credential Manager (via `keyring`), but its
//!   CredentialBlob is capped at 2560 bytes - too small to hold an RSA
//!   private key body, which made SSH "Create" fail after a successful
//!   "Test connection". DPAPI's `CryptProtectData` is bound to the
//!   current user's logon (the same trust model the Credential Manager
//!   would have given us) and has no relevant size limit. Pre-existing
//!   entries left behind in the Credential Manager are read as a
//!   fallback so password-only connections keep working without forced
//!   migration.
//! - Linux: a file in the app's local data dir, mode 0600. The default
//!   `keyring` backend on Linux is the Secret Service over D-Bus, which
//!   silently fails on systems without gnome-keyring/kwallet (and on the
//!   "login" collection not being created). For an open-source desktop
//!   app shipped via AppImage/deb/rpm, we cannot assume a keyring daemon
//!   exists. The file backend is the same approach Brave/Chromium fall
//!   back to in that scenario; user-only file permissions provide the
//!   isolation the secret-service collection would have otherwise.
//!
//! The frontend talks to `secrets_get`, `secrets_set`, `secrets_delete`,
//! and `secrets_get_all` - no platform branching in JS.
//!
//! All commands take `&AppHandle` so we can resolve the data directory
//! once via Tauri's path API.

use std::sync::Mutex;

use tauri::AppHandle;

#[cfg(any(target_os = "linux", target_os = "windows"))]
use std::collections::HashMap;
#[cfg(any(target_os = "linux", target_os = "windows"))]
use std::fs;
#[cfg(any(target_os = "linux", target_os = "windows"))]
use std::path::PathBuf;
#[cfg(any(target_os = "linux", target_os = "windows"))]
use tauri::Manager;

#[derive(Default)]
pub struct SecretsState {
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    cache: Mutex<Option<HashMap<String, String>>>,
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    _phantom: Mutex<()>,
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn key(service: &str, account: &str) -> String {
    format!("{}::{}", service, account)
}

#[cfg(target_os = "linux")]
fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("secrets.json"))
}

#[cfg(target_os = "windows")]
fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("secrets.bin"))
}

#[cfg(target_os = "linux")]
fn read_store(app: &AppHandle) -> Result<HashMap<String, String>, String> {
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    serde_json::from_slice::<HashMap<String, String>>(&bytes).map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn write_store(app: &AppHandle, map: &HashMap<String, String>) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let path = store_path(app)?;
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(map).map_err(|e| e.to_string())?;

    // 0600: only the owning user can read or write the secrets file.
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    f.write_all(&bytes).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn dpapi_protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: plain.len() as u32,
        pbData: plain.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    // SAFETY: input.pbData covers plain.len() bytes for the duration of
    // the call. CryptProtectData allocates a fresh output buffer that we
    // own and free with LocalFree below.
    let ok = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err("dpapi: CryptProtectData failed".into());
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as *mut _);
    }
    Ok(bytes)
}

#[cfg(target_os = "windows")]
fn dpapi_unprotect(cipher: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: cipher.len() as u32,
        pbData: cipher.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err("dpapi: CryptUnprotectData failed".into());
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as *mut _);
    }
    Ok(bytes)
}

#[cfg(target_os = "windows")]
fn read_store(app: &AppHandle) -> Result<HashMap<String, String>, String> {
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let cipher = fs::read(&path).map_err(|e| e.to_string())?;
    if cipher.is_empty() {
        return Ok(HashMap::new());
    }
    let plain = dpapi_unprotect(&cipher)?;
    serde_json::from_slice::<HashMap<String, String>>(&plain).map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
fn write_store(app: &AppHandle, map: &HashMap<String, String>) -> Result<(), String> {
    let path = store_path(app)?;
    let tmp = path.with_extension("bin.tmp");
    let plain = serde_json::to_vec(map).map_err(|e| e.to_string())?;
    let cipher = dpapi_protect(&plain)?;
    fs::write(&tmp, &cipher).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn with_store<F, R>(app: &AppHandle, state: &SecretsState, f: F) -> Result<R, String>
where
    F: FnOnce(&mut HashMap<String, String>) -> R,
{
    let mut guard = state.cache.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = Some(read_store(app)?);
    }
    let map = guard.as_mut().expect("cache initialized above");
    Ok(f(map))
}

#[cfg(target_os = "macos")]
fn entry(service: &str, account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, account).map_err(|e| e.to_string())
}

// Backward compat: earlier Windows builds wrote secrets to the Credential
// Manager via `keyring`. Read them as a fallback so existing password-auth
// connections keep working without forced migration; clear them out on
// `set`/`delete` so the file store stays the single source of truth.
#[cfg(target_os = "windows")]
fn legacy_keyring_get(service: &str, account: &str) -> Option<String> {
    keyring::Entry::new(service, account)
        .ok()
        .and_then(|e| e.get_password().ok())
}

#[cfg(target_os = "windows")]
fn legacy_keyring_delete(service: &str, account: &str) {
    if let Ok(e) = keyring::Entry::new(service, account) {
        let _ = e.delete_credential();
    }
}

#[tauri::command]
pub async fn secrets_get(
    app: AppHandle,
    state: tauri::State<'_, SecretsState>,
    service: String,
    account: String,
) -> Result<Option<String>, String> {
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    {
        let k = key(&service, &account);
        let hit = with_store(&app, &state, |m| m.get(&k).cloned())?;
        if hit.is_some() {
            return Ok(hit);
        }
        #[cfg(target_os = "windows")]
        {
            Ok(legacy_keyring_get(&service, &account))
        }
        #[cfg(target_os = "linux")]
        {
            Ok(None)
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = (app, state);
        let e = entry(&service, &account)?;
        match e.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(err.to_string()),
        }
    }
}

#[tauri::command]
pub async fn secrets_set(
    app: AppHandle,
    state: tauri::State<'_, SecretsState>,
    service: String,
    account: String,
    password: String,
) -> Result<(), String> {
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    {
        let k = key(&service, &account);
        with_store(&app, &state, |m| {
            m.insert(k, password);
        })?;
        let snapshot = {
            let guard = state.cache.lock().map_err(|e| e.to_string())?;
            guard.as_ref().cloned().unwrap_or_default()
        };
        write_store(&app, &snapshot)?;
        #[cfg(target_os = "windows")]
        {
            // Stale Credential Manager entry from an earlier build would
            // shadow updates on read - kill it so the file store wins.
            legacy_keyring_delete(&service, &account);
        }
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let _ = (app, state);
        let e = entry(&service, &account)?;
        e.set_password(&password).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn secrets_delete(
    app: AppHandle,
    state: tauri::State<'_, SecretsState>,
    service: String,
    account: String,
) -> Result<(), String> {
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    {
        let k = key(&service, &account);
        with_store(&app, &state, |m| {
            m.remove(&k);
        })?;
        let snapshot = {
            let guard = state.cache.lock().map_err(|e| e.to_string())?;
            guard.as_ref().cloned().unwrap_or_default()
        };
        write_store(&app, &snapshot)?;
        #[cfg(target_os = "windows")]
        {
            legacy_keyring_delete(&service, &account);
        }
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let _ = (app, state);
        let e = entry(&service, &account)?;
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        }
    }
}

/// Batch read - single IPC roundtrip for the cold-boot fan-out.
#[tauri::command]
pub async fn secrets_get_all(
    app: AppHandle,
    state: tauri::State<'_, SecretsState>,
    service: String,
    accounts: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    {
        let primary = with_store(&app, &state, |m| {
            accounts
                .iter()
                .map(|a| m.get(&key(&service, a)).cloned())
                .collect::<Vec<_>>()
        })?;
        #[cfg(target_os = "windows")]
        {
            Ok(primary
                .into_iter()
                .zip(accounts.iter())
                .map(|(v, a)| v.or_else(|| legacy_keyring_get(&service, a)))
                .collect())
        }
        #[cfg(target_os = "linux")]
        {
            Ok(primary)
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = (app, state);
        Ok(accounts
            .into_iter()
            .map(|a| {
                keyring::Entry::new(&service, &a)
                    .ok()
                    .and_then(|e| e.get_password().ok())
            })
            .collect())
    }
}
