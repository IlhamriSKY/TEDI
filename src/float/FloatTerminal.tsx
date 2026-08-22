import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { readClipboardText } from "@/lib/clipboard";
import { IS_MAC } from "@/lib/platform";
import { buildTerminalTheme } from "@/styles/terminalTheme";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { WINDOWS_PTY } from "@/modules/terminal/lib/session-helpers";
import { b64ToBytes, floatEv, type FloatSize, type FloatSnap } from "@/modules/panes/floatProtocol";

/**
 * A read/write mirror of a main-window terminal leaf. Its own xterm renders the
 * output the host forwards over Tauri events and sends keystrokes back to the
 * host, which writes them to the real PTY. Sized to the main pane (the host is
 * the size authority) to avoid resize contention on the shared shell.
 */
export function FloatTerminal({ leafId, remotePty }: { leafId: number; remotePty?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const term = new Terminal({
      theme: buildTerminalTheme(null),
      fontFamily: '"JetBrainsMono Nerd Font Mono", ui-monospace, "Cascadia Code", Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      // Follow the user's history cap like the main window does, instead of
      // pinning 10k lines. A floated pane is a second full xterm buffer, so
      // ignoring a lowered setting doubled the memory the user asked to save.
      scrollback: usePreferencesStore.getState().terminalScrollback,
      allowProposedApi: true,
      // Same ConPTY compatibility the pane picked - this xterm parses the very
      // same byte stream, and the host resizes it (the `size` listener below)
      // whenever the pane changes size. Without it, growing the pane pulls this
      // buffer's scrollback into the viewport while ConPTY repaints over it. An
      // SSH leaf's pty is a remote Unix one, so it keeps xterm's default.
      windowsPty: remotePty ? undefined : WINDOWS_PTY,
    });
    term.open(el);

    // Prefs hydrate asynchronously in this webview and can change while the
    // float is open, so track both instead of reading once at construction.
    const unsubPrefs = usePreferencesStore.subscribe((s, prev) => {
      if (s.terminalScrollback !== prev.terminalScrollback) {
        term.options.scrollback = s.terminalScrollback;
      }
    });

    const onData = term.onData((d) => void emit(floatEv.in(leafId), d));

    // Copy/paste parity with a docked pane (see TerminalPane and the
    // terminal.copy / terminal.paste shortcuts). This window has no shortcut
    // catalog of its own, so the chords hang straight off xterm, which only
    // sees a key while it holds focus - nothing here needs gating. A paste
    // rides the same `term.onData` bridge as a keystroke, so it reaches the
    // real PTY (a remote SSH one included) through the host, bracketed by
    // whatever paste mode the remote turned on in THIS xterm's parser.
    const copySelection = (): void => {
      const sel = term.getSelection();
      if (!sel) return;
      void navigator.clipboard.writeText(sel).catch((e) => {
        console.warn("float terminal copy: clipboard write failed:", e);
      });
    };
    const pasteClipboard = (): void => {
      void readClipboardText().then((text) => {
        if (text) term.paste(text);
      });
    };
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || e.altKey) return true;
      // Shift+Insert, the de-facto terminal paste on Windows/Linux.
      if (e.key === "Insert" && e.shiftKey && !e.ctrlKey && !e.metaKey) {
        pasteClipboard();
        return false;
      }
      const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!mod) return true;
      const key = e.key.toLowerCase();
      if (key === "v") {
        pasteClipboard();
        return false;
      }
      if (key === "c") {
        // Only the BARE chord may fall through: xterm turns Ctrl+Shift+C into
        // ETX as readily as Ctrl+C, so letting the explicit copy chord through
        // on an empty selection would fire SIGINT instead of doing nothing.
        const bare = !IS_MAC && !e.shiftKey;
        if (bare && !term.hasSelection()) return true; // nothing to copy: SIGINT
        copySelection();
        // Drop the highlight so the next bare Ctrl+C interrupts again.
        if (bare) term.clearSelection();
        return false;
      }
      return true;
    });

    // Right-click is context-aware and a left-drag copies on release, the same
    // two mouse conventions the docked pane implements in TerminalPane.
    const onContextMenu = (ev: MouseEvent) => {
      ev.preventDefault();
      if (term.hasSelection()) {
        copySelection();
        term.clearSelection();
        return;
      }
      pasteClipboard();
    };
    const onMouseUp = (ev: MouseEvent) => {
      if (ev.button === 0) copySelection();
    };
    el.addEventListener("contextmenu", onContextMenu);
    el.addEventListener("mouseup", onMouseUp);

    const unlisteners: UnlistenFn[] = [];
    void listen<string>(floatEv.out(leafId), (e) => term.write(b64ToBytes(e.payload))).then((u) =>
      unlisteners.push(u),
    );
    void listen<FloatSnap>(floatEv.snap(leafId), (e) => {
      term.reset();
      if (e.payload.cols && e.payload.rows) term.resize(e.payload.cols, e.payload.rows);
      if (e.payload.text) term.write(e.payload.text + "\r\n");
      term.focus();
    }).then((u) => unlisteners.push(u));
    void listen<FloatSize>(floatEv.size(leafId), (e) => {
      if (e.payload.cols && e.payload.rows) term.resize(e.payload.cols, e.payload.rows);
    }).then((u) => unlisteners.push(u));

    // Announce readiness so the host sends a snapshot; retry once for the rare
    // race where the host's HELLO listener isn't registered yet (see debugBridge).
    void emit(floatEv.hello(leafId));
    const retry = setTimeout(() => void emit(floatEv.hello(leafId)), 250);
    const bye = () => void emit(floatEv.bye(leafId));
    window.addEventListener("pagehide", bye);

    return () => {
      clearTimeout(retry);
      window.removeEventListener("pagehide", bye);
      el.removeEventListener("contextmenu", onContextMenu);
      el.removeEventListener("mouseup", onMouseUp);
      void emit(floatEv.bye(leafId));
      unsubPrefs();
      onData.dispose();
      for (const u of unlisteners) u();
      term.dispose();
    };
    // `remotePty` rides in this window's URL, so it is constant for the window's
    // life; it is listed only so the xterm option can't silently go stale.
  }, [leafId, remotePty]);

  return <div ref={ref} className="size-full overflow-hidden p-1.5" />;
}
