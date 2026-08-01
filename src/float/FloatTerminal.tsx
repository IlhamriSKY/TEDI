import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
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
