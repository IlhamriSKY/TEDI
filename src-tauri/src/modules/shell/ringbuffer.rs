use std::collections::VecDeque;

/// Byte-oriented bounded ring buffer with monotonic offsets.
///
/// Callers tail the buffer with `since_offset`. Each `push` advances
/// `next_offset` by the bytes appended, even when older bytes are dropped to
/// fit the cap. `read_from(since)` returns the slice from the requested
/// offset (clamped to what is still resident) plus the new offset.
pub struct BoundedRingBuffer {
    buf: VecDeque<u8>,
    cap: usize,
    next_offset: u64,
    /// Bytes dropped to keep the buffer at or under cap. Lets the caller
    /// detect overflow ("you missed N bytes").
    dropped: u64,
}

impl BoundedRingBuffer {
    pub fn new(cap: usize) -> Self {
        Self {
            buf: VecDeque::with_capacity(cap.min(64 * 1024)),
            cap,
            next_offset: 0,
            dropped: 0,
        }
    }

    pub fn push(&mut self, data: &[u8]) {
        self.next_offset = self.next_offset.saturating_add(data.len() as u64);
        if data.len() >= self.cap {
            // Incoming chunk alone exceeds cap: keep only its tail.
            let keep_from = data.len() - self.cap;
            self.dropped = self
                .dropped
                .saturating_add((self.buf.len() + keep_from) as u64);
            self.buf.clear();
            self.buf.extend(&data[keep_from..]);
            return;
        }
        let overflow = (self.buf.len() + data.len()).saturating_sub(self.cap);
        if overflow > 0 {
            for _ in 0..overflow {
                self.buf.pop_front();
            }
            self.dropped = self.dropped.saturating_add(overflow as u64);
        }
        self.buf.extend(data);
    }

    /// Return bytes available since `since`, plus the new offset. When
    /// `since` is older than the resident window, the returned bytes start
    /// from the oldest available offset (`next_offset - buf.len()`).
    pub fn read_from(&self, since: u64) -> (Vec<u8>, u64, u64) {
        let oldest = self.next_offset.saturating_sub(self.buf.len() as u64);
        let start = since.max(oldest);
        let skip = (start - oldest) as usize;
        let bytes: Vec<u8> = self.buf.iter().copied().skip(skip).collect();
        (bytes, self.next_offset, self.dropped)
    }
}
