//! Passphrase-encrypted blobs for the SSH connection backup (Settings ->
//! SSH -> Export connections).
//!
//! An exported backup carries the credentials that live in the OS keychain -
//! SSH passwords and private keys - so it can never be written as plaintext:
//! the file ends up on a USB stick, in Downloads, or in a synced folder. These
//! two commands are the whole crypto surface; everything above them in JS
//! handles only the already-sealed blob.
//!
//! This lives in the host process rather than the webview because
//! `crypto.subtle` is gated to secure contexts and the app origin is plain
//! http (same reason `crypto.randomUUID` is unavailable - see
//! `modules/ai/lib/httpProxy.ts`).
//!
//! Construction: PBKDF2-HMAC-SHA256 over the passphrase with a random 16-byte
//! salt, then AES-256-GCM with a random 12-byte nonce. Salt and nonce are
//! generated per seal and stored beside the ciphertext; neither is secret.
//! GCM's authentication tag is what makes a wrong passphrase, a truncated
//! file, or a flipped byte all fail closed as "wrong passphrase or corrupt
//! file" rather than yielding garbage that the importer would try to parse.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ring::{
    aead::{self, BoundKey, Nonce, NonceSequence, UnboundKey, AES_256_GCM, NONCE_LEN},
    error::Unspecified,
    pbkdf2,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use std::num::NonZeroU32;

/// Deliberately high: the passphrase is user-chosen and the file is offline,
/// so an attacker gets unlimited guesses. OWASP's 2023 floor for
/// PBKDF2-HMAC-SHA256 is 600k. Stored in the envelope rather than hardcoded on
/// the read path so raising it later still opens older backups.
const PBKDF2_ITERATIONS: u32 = 600_000;
const SALT_LEN: usize = 16;

#[derive(Serialize, Deserialize)]
pub struct SealedBlob {
    /// Named so a future format change is a value check, not a guess.
    pub kdf: String,
    pub iterations: u32,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

/// `ring`'s sealing API consumes a nonce sequence; we seal exactly one message
/// per key, so the sequence yields our single random nonce and then refuses.
/// Refusing matters: reusing a nonce under the same key breaks GCM completely.
struct OneNonce(Option<[u8; NONCE_LEN]>);

impl NonceSequence for OneNonce {
    fn advance(&mut self) -> Result<Nonce, Unspecified> {
        self.0
            .take()
            .map(Nonce::assume_unique_for_key)
            .ok_or(Unspecified)
    }
}

fn derive_key(passphrase: &str, salt: &[u8], iterations: u32) -> Result<[u8; 32], String> {
    let iters =
        NonZeroU32::new(iterations).ok_or_else(|| "backup: iteration count is zero".to_string())?;
    let mut key = [0u8; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        iters,
        salt,
        passphrase.as_bytes(),
        &mut key,
    );
    Ok(key)
}

/// Encrypt `plaintext` under `passphrase`. Returns the blob to embed in the
/// export file. An empty passphrase is refused here rather than in the UI so
/// the guarantee holds no matter which caller reaches this.
#[tauri::command]
pub async fn backup_seal(plaintext: String, passphrase: String) -> Result<SealedBlob, String> {
    if passphrase.is_empty() {
        return Err("backup: a passphrase is required".into());
    }
    let rng = SystemRandom::new();
    let mut salt = [0u8; SALT_LEN];
    rng.fill(&mut salt)
        .map_err(|_| "backup: random salt failed".to_string())?;
    let mut nonce = [0u8; NONCE_LEN];
    rng.fill(&mut nonce)
        .map_err(|_| "backup: random nonce failed".to_string())?;

    let key = derive_key(&passphrase, &salt, PBKDF2_ITERATIONS)?;
    let unbound = UnboundKey::new(&AES_256_GCM, &key).map_err(|_| "backup: bad key".to_string())?;
    let mut sealing = aead::SealingKey::new(unbound, OneNonce(Some(nonce)));

    // seal_in_place_append_tag appends the 16-byte auth tag, so `buf` ends up
    // as ciphertext||tag - which is exactly what open_in_place expects back.
    let mut buf = plaintext.into_bytes();
    sealing
        .seal_in_place_append_tag(aead::Aad::empty(), &mut buf)
        .map_err(|_| "backup: encryption failed".to_string())?;

    Ok(SealedBlob {
        kdf: "pbkdf2-hmac-sha256".into(),
        iterations: PBKDF2_ITERATIONS,
        salt: B64.encode(salt),
        nonce: B64.encode(nonce),
        ciphertext: B64.encode(&buf),
    })
}

/// Decrypt a blob produced by `backup_seal`. Every failure below - wrong
/// passphrase, tampered ciphertext, truncated file - is reported with the same
/// message on purpose: distinguishing them tells an attacker which guess was
/// closer, and none of them is separately actionable for the user.
#[tauri::command]
pub async fn backup_open(blob: SealedBlob, passphrase: String) -> Result<String, String> {
    if blob.kdf != "pbkdf2-hmac-sha256" {
        return Err(format!(
            "backup: unsupported key derivation \"{}\"",
            blob.kdf
        ));
    }
    let salt = B64
        .decode(&blob.salt)
        .map_err(|_| "backup: malformed salt".to_string())?;
    let nonce_bytes = B64
        .decode(&blob.nonce)
        .map_err(|_| "backup: malformed nonce".to_string())?;
    let mut buf = B64
        .decode(&blob.ciphertext)
        .map_err(|_| "backup: malformed ciphertext".to_string())?;
    let nonce: [u8; NONCE_LEN] = nonce_bytes
        .as_slice()
        .try_into()
        .map_err(|_| "backup: malformed nonce".to_string())?;

    let key = derive_key(&passphrase, &salt, blob.iterations)?;
    let unbound = UnboundKey::new(&AES_256_GCM, &key).map_err(|_| "backup: bad key".to_string())?;
    let mut opening = aead::OpeningKey::new(unbound, OneNonce(Some(nonce)));

    let plain = opening
        .open_in_place(aead::Aad::empty(), &mut buf)
        .map_err(|_| "backup: wrong passphrase, or the file is corrupt".to_string())?;
    String::from_utf8(plain.to_vec())
        .map_err(|_| "backup: decrypted data is not valid UTF-8".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seal(pt: &str, pw: &str) -> SealedBlob {
        tauri::async_runtime::block_on(backup_seal(pt.into(), pw.into())).expect("seal")
    }
    fn open(b: SealedBlob, pw: &str) -> Result<String, String> {
        tauri::async_runtime::block_on(backup_open(b, pw.into()))
    }

    #[test]
    fn round_trips() {
        let pt = r#"{"c-1":{"password":"hunter2"}}"#;
        assert_eq!(
            open(seal(pt, "correct horse"), "correct horse").unwrap(),
            pt
        );
    }

    #[test]
    fn wrong_passphrase_fails_closed() {
        // The whole point of the auth tag: a bad passphrase must not yield
        // plausible-looking bytes for the importer to parse.
        let err = open(seal("secret", "right"), "wrong").unwrap_err();
        assert!(err.contains("wrong passphrase"), "unexpected error: {err}");
    }

    #[test]
    fn tampered_ciphertext_fails_closed() {
        let mut b = seal("secret", "pw");
        let mut raw = B64.decode(&b.ciphertext).unwrap();
        raw[0] ^= 0x01;
        b.ciphertext = B64.encode(&raw);
        assert!(open(b, "pw").is_err());
    }

    #[test]
    fn empty_passphrase_is_refused() {
        assert!(tauri::async_runtime::block_on(backup_seal("x".into(), String::new())).is_err());
    }

    #[test]
    fn salt_and_nonce_differ_per_seal() {
        // Same plaintext and passphrase must never produce the same bytes, or
        // two exports would reveal that nothing changed between them.
        let (a, b) = (seal("same", "pw"), seal("same", "pw"));
        assert_ne!(a.salt, b.salt);
        assert_ne!(a.nonce, b.nonce);
        assert_ne!(a.ciphertext, b.ciphertext);
    }

    #[test]
    fn unicode_survives() {
        let pt = "kunci rahasia — ✓ 日本語";
        assert_eq!(open(seal(pt, "pw"), "pw").unwrap(), pt);
    }
}
