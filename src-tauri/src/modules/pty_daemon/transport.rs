// Length-prefixed JSON framing for the daemon IPC socket.
//
// Wire format: 4-byte big-endian payload length, then UTF-8 JSON.
// Why prefix: JSON terminator detection (newline scanning) breaks if a
// payload ever embeds a literal newline byte - escaped or otherwise. A
// hard length prefix decouples framing from payload bytes.
//
// `MAX_FRAME_SIZE` caps each frame at 16 MiB. The biggest realistic frame
// is `AttachOk` carrying a scrollback dump (capped server-side around 1
// MiB), so 16 MiB leaves headroom without permitting OOM via a malicious
// or buggy peer.

use std::io::{self, Read, Write};

#[cfg(unix)]
use interprocess::local_socket::GenericFilePath;
#[cfg(windows)]
use interprocess::local_socket::GenericNamespaced;
use interprocess::local_socket::{traits::Stream as _StreamTrait, Stream};
use serde::{de::DeserializeOwned, Serialize};

pub const MAX_FRAME_SIZE: usize = 16 * 1024 * 1024;

pub fn write_frame<W: Write>(w: &mut W, body: &[u8]) -> io::Result<()> {
    let len = body.len();
    if len > MAX_FRAME_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("frame too large: {len} > {MAX_FRAME_SIZE}"),
        ));
    }
    let prefix = (len as u32).to_be_bytes();
    w.write_all(&prefix)?;
    w.write_all(body)?;
    w.flush()
}

pub fn read_frame<R: Read>(r: &mut R) -> io::Result<Vec<u8>> {
    let mut prefix = [0u8; 4];
    r.read_exact(&mut prefix)?;
    let len = u32::from_be_bytes(prefix) as usize;
    if len > MAX_FRAME_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame too large: {len} > {MAX_FRAME_SIZE}"),
        ));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    Ok(buf)
}

pub fn write_msg<W: Write, T: Serialize>(w: &mut W, msg: &T) -> io::Result<()> {
    let body =
        serde_json::to_vec(msg).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    write_frame(w, &body)
}

pub fn read_msg<R: Read, T: DeserializeOwned>(r: &mut R) -> io::Result<T> {
    let frame = read_frame(r)?;
    serde_json::from_slice(&frame).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// Open a fresh connection to the daemon. Both arms produce a sync
/// `Stream`; the difference is namespacing (filesystem path on Unix,
/// kernel namespace on Windows).
pub fn connect_to_daemon() -> io::Result<Stream> {
    #[cfg(unix)]
    {
        use interprocess::local_socket::ToFsName;
        let path = super::paths::socket_path();
        let name = path.as_path().to_fs_name::<GenericFilePath>()?;
        Stream::connect(name)
    }
    #[cfg(windows)]
    {
        use interprocess::local_socket::ToNsName;
        let name_str = super::paths::socket_name();
        let name = name_str.as_str().to_ns_name::<GenericNamespaced>()?;
        Stream::connect(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn frame_roundtrip() {
        let mut buf = Vec::new();
        write_frame(&mut buf, b"hello world").unwrap();
        let mut cur = Cursor::new(buf);
        let got = read_frame(&mut cur).unwrap();
        assert_eq!(got, b"hello world");
    }

    #[test]
    fn frame_too_large_on_write() {
        let mut buf = Vec::new();
        let body = vec![0u8; MAX_FRAME_SIZE + 1];
        let err = write_frame(&mut buf, &body).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn frame_too_large_on_read() {
        let mut buf = Vec::new();
        // Forge a length prefix bigger than the cap with no body.
        let bad_len = (MAX_FRAME_SIZE as u32) + 1;
        buf.extend_from_slice(&bad_len.to_be_bytes());
        let mut cur = Cursor::new(buf);
        let err = read_frame(&mut cur).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn split_reads_reassemble() {
        // The `read_exact` semantics handle short reads transparently; the
        // test documents that property rather than the framing code.
        let mut buf = Vec::new();
        write_frame(&mut buf, b"abcdef").unwrap();
        let mut cur = Cursor::new(buf);
        let got = read_frame(&mut cur).unwrap();
        assert_eq!(got, b"abcdef");
    }
}
