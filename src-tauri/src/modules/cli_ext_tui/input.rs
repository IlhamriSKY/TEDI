//! Minimal single-line text input. Owns a `String` + insertion cursor in
//! byte offsets, validates that the cursor always lands on a UTF-8 char
//! boundary. Replaces the `tui-input` crate (which we don't pull in to
//! keep the dep footprint minimal).
//!
//! Supports: char insert, backspace, delete, home/end, left/right, Ctrl+W
//! (delete previous word), Ctrl+U (clear). Cursor is measured in bytes
//! internally but `cursor_display()` returns the column for the renderer.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

#[derive(Debug, Clone, Default)]
pub struct Input {
    value: String,
    /// Byte offset within `value`. Must land on a UTF-8 boundary.
    cursor: usize,
}

impl Input {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_text(text: impl Into<String>) -> Self {
        let value = text.into();
        let cursor = value.len();
        Self { value, cursor }
    }

    pub fn value(&self) -> &str {
        &self.value
    }

    pub fn is_empty(&self) -> bool {
        self.value.is_empty()
    }

    /// Display column under the cursor. For an ASCII-only string this is
    /// the byte index; for multi-byte UTF-8 we'd need a wider routine, but
    /// extension ids and owner/repo refs are ASCII so byte-count is exact.
    pub fn cursor_display(&self) -> u16 {
        self.value[..self.cursor].chars().count() as u16
    }

    pub fn clear(&mut self) {
        self.value.clear();
        self.cursor = 0;
    }

    /// Handle a key event. Returns `true` when the event was consumed. The
    /// caller decides what `Enter` / `Esc` mean — they fall through here.
    pub fn handle_key(&mut self, key: KeyEvent) -> bool {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        match key.code {
            KeyCode::Char('w') if ctrl => {
                self.delete_word_back();
                true
            }
            KeyCode::Char('u') if ctrl => {
                self.clear();
                true
            }
            KeyCode::Char(c) if !ctrl => {
                let mut buf = [0u8; 4];
                let s = c.encode_utf8(&mut buf);
                self.value.insert_str(self.cursor, s);
                self.cursor += s.len();
                true
            }
            KeyCode::Backspace => {
                self.backspace();
                true
            }
            KeyCode::Delete => {
                self.delete_forward();
                true
            }
            KeyCode::Left => {
                self.move_left();
                true
            }
            KeyCode::Right => {
                self.move_right();
                true
            }
            KeyCode::Home => {
                self.cursor = 0;
                true
            }
            KeyCode::End => {
                self.cursor = self.value.len();
                true
            }
            _ => false,
        }
    }

    fn backspace(&mut self) {
        if self.cursor == 0 {
            return;
        }
        let prev = prev_char_boundary(&self.value, self.cursor);
        self.value.replace_range(prev..self.cursor, "");
        self.cursor = prev;
    }

    fn delete_forward(&mut self) {
        if self.cursor >= self.value.len() {
            return;
        }
        let next = next_char_boundary(&self.value, self.cursor);
        self.value.replace_range(self.cursor..next, "");
    }

    fn move_left(&mut self) {
        if self.cursor == 0 {
            return;
        }
        self.cursor = prev_char_boundary(&self.value, self.cursor);
    }

    fn move_right(&mut self) {
        if self.cursor >= self.value.len() {
            return;
        }
        self.cursor = next_char_boundary(&self.value, self.cursor);
    }

    fn delete_word_back(&mut self) {
        if self.cursor == 0 {
            return;
        }
        let bytes = self.value.as_bytes();
        let mut i = self.cursor;
        // Skip trailing whitespace.
        while i > 0 && bytes[i - 1].is_ascii_whitespace() {
            i -= 1;
        }
        // Then skip the word.
        while i > 0 && !bytes[i - 1].is_ascii_whitespace() {
            i -= 1;
        }
        self.value.replace_range(i..self.cursor, "");
        self.cursor = i;
    }
}

fn prev_char_boundary(s: &str, mut i: usize) -> usize {
    if i == 0 {
        return 0;
    }
    i -= 1;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn next_char_boundary(s: &str, mut i: usize) -> usize {
    let len = s.len();
    if i >= len {
        return len;
    }
    i += 1;
    while i < len && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(c: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)
    }

    #[test]
    fn type_then_backspace() {
        let mut i = Input::new();
        assert!(i.handle_key(key('a')));
        assert!(i.handle_key(key('b')));
        assert!(i.handle_key(key('c')));
        assert_eq!(i.value(), "abc");
        assert!(i.handle_key(KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE)));
        assert_eq!(i.value(), "ab");
    }

    #[test]
    fn ctrl_u_clears() {
        let mut i = Input::with_text("hello");
        assert!(i.handle_key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL)));
        assert_eq!(i.value(), "");
    }

    #[test]
    fn ctrl_w_deletes_word() {
        let mut i = Input::with_text("foo bar baz");
        assert!(i.handle_key(KeyEvent::new(KeyCode::Char('w'), KeyModifiers::CONTROL)));
        assert_eq!(i.value(), "foo bar ");
    }

    #[test]
    fn unrecognized_returns_false() {
        let mut i = Input::new();
        assert!(!i.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
        assert!(!i.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
    }
}
