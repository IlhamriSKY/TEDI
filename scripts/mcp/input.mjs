/**
 * Real input into the TEDI window: keys, typing, mouse. Plain data over one `send(method, params)`
 * DevTools call, with no Node API, so the app's own realm runs it too: `Driver` extends this over a
 * socket or the bridge, and `handlers.mjs` runs it for `tedi keys`, the stdio server and TEDI's agent.
 */

/** CDP's modifier bitmask. `mod` follows TEDI's own Mod = Cmd on mac, Ctrl elsewhere. */
const MODIFIER_BITS = {
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  super: 4,
  shift: 8,
  mod: /^(darwin|mac)/i.test(globalThis.process?.platform ?? globalThis.navigator?.platform ?? "")
    ? 4
    : 2,
};

/** Keys that are not a single printable character. `text` is what a terminal wants. */
const NAMED_KEYS = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9, text: "\t" },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
};
for (let n = 1; n <= 12; n++) NAMED_KEYS[`f${n}`] = { key: `F${n}`, code: `F${n}`, vk: 111 + n };

/**
 * US-layout `code` + Windows virtual-key for the printable characters that are
 * neither a letter nor a digit, with the shifted character that shares the key.
 * Synthesised keystrokes need a real virtual-key code: an event carrying only
 * `text` is not a keystroke any renderer takes seriously.
 */
const PUNCTUATION = [
  [" ", " ", "Space", 32],
  ["-", "_", "Minus", 189],
  ["=", "+", "Equal", 187],
  ["[", "{", "BracketLeft", 219],
  ["]", "}", "BracketRight", 221],
  ["\\", "|", "Backslash", 220],
  [";", ":", "Semicolon", 186],
  ["'", '"', "Quote", 222],
  ["`", "~", "Backquote", 192],
  [",", "<", "Comma", 188],
  [".", ">", "Period", 190],
  ["/", "?", "Slash", 191],
];
const SHIFTED_DIGITS = ")!@#$%^&*(";

/** CDP key-event fields for one printable character, as a real keyboard sends it. */
function charEvent(ch) {
  const upper = ch.toUpperCase();
  if (ch >= "a" && ch <= "z") return { code: `Key${upper}`, vk: upper.charCodeAt(0), shift: false };
  if (ch >= "A" && ch <= "Z") return { code: `Key${upper}`, vk: upper.charCodeAt(0), shift: true };
  if (ch >= "0" && ch <= "9") return { code: `Digit${ch}`, vk: ch.charCodeAt(0), shift: false };
  const shiftedDigit = SHIFTED_DIGITS.indexOf(ch);
  if (shiftedDigit !== -1) {
    return { code: `Digit${shiftedDigit}`, vk: 48 + shiftedDigit, shift: true };
  }
  for (const [plain, shifted, code, vk] of PUNCTUATION) {
    if (ch === plain) return { code, vk, shift: false };
    if (ch === shifted) return { code, vk, shift: true };
  }
  // Anything else (accents, CJK, emoji) has no US-layout key. Fall back to a
  // text-only event; it is not a keystroke, but it beats dropping the character.
  return { code: undefined, vk: 0, shift: false };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `Ctrl+Shift+P` -> the CDP key event fields for one press. Exported for the
 *  sweep's chord check, which is the only guard on the virtual-key mapping: the
 *  `Ctrl+/` check passes either way, because CodeMirror reads `event.key`. */
export function parseChord(chord) {
  const parts = String(chord).split("+").filter(Boolean);
  const last = parts.pop();
  let modifiers = 0;
  for (const p of parts) {
    const bit = MODIFIER_BITS[p.toLowerCase()];
    if (!bit) throw new Error(`Unknown modifier "${p}" in "${chord}"`);
    modifiers |= bit;
  }
  const named = NAMED_KEYS[String(last).toLowerCase()];
  if (named) return { ...named, modifiers };
  if (last.length !== 1) throw new Error(`Unknown key "${last}" in "${chord}"`);
  const upper = last.toUpperCase();
  // Through `charEvent`, not a second hand-rolled lookup: deriving the virtual
  // key from the character itself gave `Ctrl+/` vk 47 instead of 191, which
  // survived only because CodeMirror reads `event.key`. Anything reading the
  // virtual key saw a different key entirely.
  const { code, vk } = charEvent(last);
  return {
    key: modifiers & MODIFIER_BITS.shift ? upper : last,
    code,
    vk: vk || upper.charCodeAt(0),
    // A char event only fires without Ctrl/Meta held; sending `text` alongside
    // them makes the page see a literal character on top of the shortcut.
    text: modifiers & (MODIFIER_BITS.ctrl | MODIFIER_BITS.meta) ? undefined : last,
    modifiers,
  };
}

export class WindowInput {
  /** @param {{ send: (method: string, params?: object) => Promise<any> }} cdp */
  constructor(cdp) {
    this.cdp = cdp;
  }

  async eval(expression) {
    const { result, exceptionDetails } = await this.cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  }

  /**
   * Call a Tauri command in the app's own realm.
   *
   * `__TAURI_INTERNALS__` is injected into every TEDI webview, so every Rust
   * command is one hop away without registering anything new on `window.__tedi`.
   * That is what reaches capabilities with no frontend function to expose: a
   * Rust command that nothing on `window.__tedi` wraps is still one hop away.
   *
   * Arguments go through `JSON.stringify`, so a URL with quotes or a Windows
   * path full of backslashes cannot end the injected string early.
   */
  async keys(...chords) {
    for (const chord of chords) {
      const k = parseChord(chord);
      const base = {
        modifiers: k.modifiers,
        key: k.key,
        code: k.code,
        windowsVirtualKeyCode: k.vk,
        nativeVirtualKeyCode: k.vk,
      };
      await this.cdp.send("Input.dispatchKeyEvent", {
        ...base,
        type: k.text ? "keyDown" : "rawKeyDown",
        text: k.text,
        unmodifiedText: k.text,
      });
      await this.cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
      await sleep(12);
    }
  }

  /**
   * Type text a character at a time. The per-character delay is the point: an
   * instant paste reads as a cut in the footage, a human cadence does not.
   * A trailing "\r" or "\n" is sent as Enter, which is what a PTY wants.
   */
  /**
   * Type text a character at a time, as real key events.
   *
   * NOT `Input.insertText`: Chromium delivers that as an IME commit, and xterm's
   * composition handling swallows the first one into a freshly focused terminal,
   * so every `echo` typed into a just-split pane arrived as `cho` no matter how
   * long the take waited first. Full key events (with a genuine `code` and
   * virtual-key, which an earlier text-only version was missing) go down the
   * ordinary keydown path and land intact.
   */
  async type(text, { delay = 45 } = {}) {
    for (const ch of String(text)) {
      if (ch === "\n" || ch === "\r") {
        await this.keys("Enter");
      } else {
        const { code, vk, shift } = charEvent(ch);
        const base = {
          modifiers: shift ? MODIFIER_BITS.shift : 0,
          key: ch,
          code,
          windowsVirtualKeyCode: vk,
          nativeVirtualKeyCode: vk,
        };
        await this.cdp.send("Input.dispatchKeyEvent", {
          ...base,
          type: "keyDown",
          text: ch,
          unmodifiedText: ch,
        });
        await this.cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
      }
      if (delay) await sleep(delay);
    }
  }

  /**
   * Viewport rect of a CSS selector, or null. `nth` picks among matches, which
   * is not optional in practice: a split window has one
   * `[data-slot=resizable-handle]` per divider and only the index tells them
   * apart.
   */
  box(selector, { nth = 0 } = {}) {
    return this.eval(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${Number(nth)}];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`);
  }

  async waitFor(selector, { nth = 0, timeout = 10000 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const box = await this.box(selector, { nth });
      // One dimension is enough. A collapsed sidebar's resize handle is 0 wide
      // and ~1000 tall, and demanding both made it unreachable, which is exactly
      // when you need to grab it: to drag the sidebar back open.
      if (box && (box.width > 0 || box.height > 0)) return box;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for "${selector}" [${nth}]`);
      await sleep(100);
    }
  }

  async #mouse(type, x, y, extra = {}) {
    await this.cdp.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      buttons: type === "mouseMoved" ? (extra.held ? 1 : 0) : 1,
      clickCount: 1,
      ...extra,
    });
  }

  /**
   * Bring a target into view before pointing at it. `getBoundingClientRect` is
   * viewport-relative, so an element below the fold reports coordinates outside
   * the window and the synthetic mouse event lands on whatever is actually
   * there. That failure is silent: the call "succeeds" and nothing happens.
   */
  async #scrollIntoView(selector, nth) {
    await this.eval(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${Number(nth)}];
      el?.scrollIntoView({ block: "center", inline: "center" });
      return true;
    })()`);
    await sleep(250);
  }

  /**
   * Is something else on top of this element, or is input disabled on it?
   * Returns a description of the blocker, or null when the click can land.
   *
   * An open Radix modal sets `pointer-events: none` on `document.body`, so every
   * button behind it silently ignores clicks while still reporting a perfectly
   * good bounding box. A toast stacked over the header does the same locally.
   * Both cost hours before this check existed.
   */
  #blocker(selector, nth) {
    return this.eval(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${Number(nth)}];
      if (!el) return "element is gone";
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
      if (top === el || el.contains(top) || (top && top.contains(el))) return null;
      const modal = document.querySelector('[role=dialog][data-state=open],[role=alertdialog][data-state=open]');
      const label = modal ? (modal.textContent || "").trim().slice(0, 60) : null;
      return (modal ? 'a modal is open ("' + label + '") and its overlay swallows the click; ' : "") +
        "topmost element there is " + (top ? top.tagName + "." + String(top.className).slice(0, 30) : "nothing");
    })()`);
  }

  /**
   * Move the pointer over a selector and leave it there.
   *
   * Rows that reveal their controls on hover need this before the control can be
   * clicked at all: a workspace row shows a tab-count badge until you hover it,
   * and the Rename / Close buttons sit underneath that badge.
   */
  async hover(selector, { nth = 0 } = {}) {
    await this.#scrollIntoView(selector, nth);
    const box = await this.waitFor(selector, { nth });
    await this.#mouse("mouseMoved", box.x + box.width / 2, box.y + box.height / 2);
    await sleep(400);
    return box;
  }

  /** Real mouse click at the centre of a selector. */
  async click(selector, { nth = 0 } = {}) {
    await this.waitFor(selector, { nth });
    await this.#scrollIntoView(selector, nth);
    let blocked = await this.#blocker(selector, nth);
    if (blocked) {
      // Try hovering once before giving up. A lot of this UI only materialises
      // under the pointer: a workspace row and a pane header both show a count
      // badge until hovered, with Rename / Close sitting underneath it. Moving
      // the mouse onto the badge still hovers the row, which reveals them.
      await this.hover(selector, { nth });
      blocked = await this.#blocker(selector, nth);
    }
    if (blocked) throw new Error(`cannot click "${selector}" [${nth}]: ${blocked}`);
    const box = await this.waitFor(selector, { nth });
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await this.#mouse("mouseMoved", x, y);
    await this.#mouse("mousePressed", x, y);
    await this.#mouse("mouseReleased", x, y);
    await sleep(60);
  }

  /**
   * Drag from the centre of a selector by (dx, dy) in steps, so pane splitters
   * see the intermediate moves they need. This is how panes get resized: they
   * are `react-resizable-panels` handles, driven by pointer movement.
   */
  async drag(selector, dx, dy, { steps = 20, nth = 0 } = {}) {
    await this.waitFor(selector, { nth });
    await this.#scrollIntoView(selector, nth);
    const box = await this.waitFor(selector, { nth });
    const x0 = box.x + box.width / 2;
    const y0 = box.y + box.height / 2;
    await this.#mouse("mouseMoved", x0, y0);
    await this.#mouse("mousePressed", x0, y0);
    for (let i = 1; i <= steps; i++) {
      await this.#mouse("mouseMoved", x0 + (dx * i) / steps, y0 + (dy * i) / steps, { held: true });
      await sleep(16);
    }
    await this.#mouse("mouseReleased", x0 + dx, y0 + dy);
    await sleep(60);
  }

  /** The window as a base64 PNG. */
  async capture() {
    const { data } = await this.cdp.send("Page.captureScreenshot", { format: "png" });
    return data;
  }
}
