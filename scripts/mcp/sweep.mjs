/**
 * Control sweep: walk TEDI's surface and prove each area is drivable, by
 * asserting a measurable change rather than by "the command did not throw".
 *
 *   pnpm mcp sweep
 *
 * Two rules the first version got wrong and that matter more than the checks
 * themselves:
 *
 *   1. A check that fails must still put back what it changed. The first run
 *      left the sidebar collapsed and every later explorer and editor check
 *      failed for that reason alone, which reads as six broken features
 *      instead of one broken check.
 *   2. Preflight into a real project folder. A shell starts in $HOME, and when
 *      $HOME is a large git repo the app spends its main thread on git
 *      decorations, at which point synthetic input starts going missing and the
 *      results mean nothing.
 *
 * Nothing here mutates git state, user files, or saved workspaces; anything
 * deliberately not exercised is listed at the end rather than passed over.
 */

const PROJECT = process.env.SWEEP_PROJECT ?? "D:\\Ilham\\Project\\laragon\\www\\TEDI - terax-ai";
const SCRATCH = "sweep-scratch.md";

const results = [];
const skipped = [];

async function check(name, fn, cleanup) {
  try {
    const evidence = await fn();
    results.push({ name, ok: true, evidence: String(evidence ?? "ok").slice(0, 88) });
  } catch (err) {
    results.push({ name, ok: false, evidence: String(err.message).slice(0, 120) });
  } finally {
    // Always, even on failure: a leaked toggle poisons every later check.
    if (cleanup) {
      try {
        await cleanup();
      } catch {
        /* a cleanup that cannot run must not mask the result */
      }
    }
  }
}

export default async function sweep(d) {
  const n = (sel) => d.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  const tabs = () =>
    d.eval(
      `[...new Set([...document.querySelectorAll('[data-tab-id]')].map(e=>e.getAttribute('data-tab-id')))].length`,
    );
  const leaves = () => n("[data-pane-leaf]");
  const editors = () => n(".cm-content");
  const sidebarWidth = () =>
    d.eval(
      `Math.round(document.querySelector('[data-testid=sidebar]')?.getBoundingClientRect().width ?? 0)`,
    );
  const zoom = () =>
    d.eval(`getComputedStyle(document.documentElement).getPropertyValue('--content-zoom').trim()`);
  const wait = (ms = 1200) => d.wait(ms);

  /** See `Driver.paneHandleIndex`: a fixed `nth` once dragged the sidebar down
   *  to 16px and took every later explorer and editor check with it. */
  const paneHandle = () => d.paneHandleIndex();

  /** A usable sidebar, not merely a non-zero one. */
  async function ensureSidebar() {
    if ((await sidebarWidth()) === 0) {
      await d.cmd("sidebar.toggle");
      await wait(1400);
    }
    // Widening takes several drags, not one: the panel library works in
    // percentages and clamps a single gesture, so one 220px pull off a collapsed
    // sidebar lands around 50px. Pull until it is usable or give up and let the
    // baseline report the width.
    for (let i = 0; i < 5; i++) {
      const w = await sidebarWidth();
      if (w >= 200) break;
      if ((await n("[data-slot=resizable-handle]")) === 0) break;
      await d.drag("[data-slot=resizable-handle]", 240 - w, 0, { nth: 0 });
      await wait(800);
    }
  }

  /** One tab, one leaf, sidebar open, shell in the project. */
  async function normalise() {
    await d.keys("Escape");
    for (let i = 0; i < 12 && (await tabs()) > 1; i++) {
      await d.cmd("tab.close");
      await wait(900);
    }
    // "Close pane", not `terminal.close`: the latter only closes a TERMINAL, so
    // an editor or extension leaf survives it and the loop spins forever. Keep
    // going while a non-terminal is the survivor too, because the checks below
    // type shell commands, and closing the last pane hands back a fresh
    // terminal tab.
    const needsClosing = async () => (await leaves()) > 1 || (await n(".xterm-screen")) === 0;
    for (let i = 0; i < 12 && (await needsClosing()); i++) {
      const last = Math.max(0, (await leaves()) - 1);
      await d.click('button[aria-label="Close pane"]', { nth: last });
      await wait(1200);
    }
    await ensureSidebar();
    // Closing every tab spawns a fresh shell, and a fresh shell starts in $HOME.
    await d.command(`cd '${PROJECT}'`, { delay: 8 });
    await wait(2200);
    await d.command("clear", { delay: 8 });
    await wait(700);
  }

  // --- preflight ----------------------------------------------------------
  // Check the window is a usable size FIRST. A shrunken or off-screen window
  // (this one was once found parked at -25600,-25600 at 128x22 after a long
  // automated run) makes every layout-dependent check fail for one reason,
  // reported as a dozen unrelated ones.
  const view = await d.eval("({ w: innerWidth, h: innerHeight })");
  if (view.w < 900 || view.h < 600) {
    throw new Error(
      `window is ${view.w}x${view.h}: restore it before sweeping (it may be parked off-screen)`,
    );
  }
  // Reload before measuring anything. A long automated run leaves the layout
  // drifted (panes, WebGL contexts, a sidebar that has been collapsed and
  // restored a dozen times), and a second sweep against that state fails in
  // ways that say nothing about the app. A reload is the cheapest way to make
  // runs repeatable; TEDI restores its workspace from the store.
  await d.eval("location.reload(); 1");
  await wait(9000);
  for (let i = 0; i < 20; i++) {
    if (await d.eval("document.body.innerHTML.length > 20000")) break;
    await wait(1000);
  }
  await normalise();
  const base = { tabs: await tabs(), leaves: await leaves(), sidebar: await sidebarWidth() };
  console.log("baseline:", JSON.stringify(base));
  if (base.sidebar < 120) throw new Error(`preflight failed: sidebar is ${base.sidebar}px`);
  if (base.leaves !== 1 || base.tabs !== 1) {
    throw new Error(`preflight failed: ${base.tabs} tabs, ${base.leaves} leaves`);
  }

  await check("command registry populated", async () => `${(await d.commands()).length} ids`);

  // The check the terminal readback path leaves behind. It is the one thing in
  // here with no DOM fallback: xterm draws to a WebGL canvas, so if
  // `window.__tedi.terminals` is missing or the buffer comes back empty, a
  // driver is running commands blind and every later check that reads output is
  // meaningless. Also proves `command()` really waits for the prompt: without
  // that wait, the echo has not landed yet when the buffer is read.
  await check("terminal buffer is readable", async () => {
    // Short on purpose. The stamp has to survive on ONE line next to a prompt
    // that is already an absolute path, and a wrapped line breaks the match in
    // the middle with nothing to show for it.
    const stamp = `rb${(await d.eval("performance.now().toFixed(0)")).slice(-5)}`;
    await d.command(`echo ${stamp}`);
    const leafId = await d.focusedLeaf();
    const term = (await d.terminals(40)).find((t) => t.leafId === leafId);
    if (!term) throw new Error("focused leaf is not a terminal");
    // Twice: once as the echoed command line, once as its output. One match
    // means the command was typed but never ran, which is also what a broken
    // `command()` prompt-wait looks like from here.
    const hits = term.text.split("\n").filter((l) => l.includes(stamp)).length;
    if (hits < 2) throw new Error(`${hits} occurrence(s) of "${stamp}", expected 2`);
    return `${hits} hits, atPrompt=${term.atPrompt}, running=${term.running}`;
  });

  // Panes across tabs, and the wait that replaces a polling loop. Both are the
  // "know what the other panes are doing" half: a driver that can only see the
  // focused pane cannot wait on a build running in a background tab.
  await check(
    "panes() sees a background tab, and wait() returns at the prompt",
    async () => {
      const before = (await d.panes()).length;
      await d.cmd("tab.new");
      await wait(2500);
      const after = await d.panes();
      if (after.length <= before)
        throw new Error(`${before} -> ${after.length} panes after tab.new`);
      const terms = after.filter((p) => p.kind === "terminal");
      if (!terms.length) throw new Error("no terminal panes in the model view");
      // Every terminal must carry the identity a driver picks a target by.
      const naked = terms.find((p) => typeof p.atPrompt !== "boolean");
      if (naked) throw new Error(`terminal pane has no prompt state: ${JSON.stringify(naked)}`);
      const w = await d.waitTerminal({ timeout: 15000 });
      if (!w.done) throw new Error(`wait did not settle: ${w.reason}`);
      return `${after.length} panes across tabs, wait -> ${w.reason}`;
    },
    async () => {
      while ((await tabs()) > base.tabs) {
        await d.cmd("tab.close");
        await wait(1200);
      }
    },
  );

  // Extensions were the blind spot: their commands live in a registry of their
  // own, so `commands()` never listed them and `cmd()` could never reach them.
  // A zero-extension profile is legitimate, so this asserts the SHAPE, not a
  // count - the failure it guards is the accessor being gone, not the list
  // being empty.
  await check("extensions() reports what each one contributes", async () => {
    const list = await d.extensions();
    if (!Array.isArray(list)) throw new Error(`not an array: ${JSON.stringify(list)}`);
    for (const e of list) {
      if (!e.id || typeof e.enabled !== "boolean" || !Array.isArray(e.commands)) {
        throw new Error(`malformed entry: ${JSON.stringify(e)}`);
      }
    }
    // An id nothing answers to must come back false rather than throwing, which
    // is the same answer a disabled extension gives.
    if (await d.extCommand("no.such.extension", "nope")) {
      throw new Error("extCommand claimed to run a command that does not exist");
    }
    return `${list.length} installed, ${list.filter((e) => e.enabled).length} enabled`;
  });

  // The extension lifecycle, driven round-trip and PUT BACK. Every action here
  // touches the user's real profile, so the check disables and re-enables the
  // same extension rather than picking a victim to uninstall.
  await check("extControl() turns an extension off and back on", async () => {
    const list = await d.extensions();
    const victim = list.find((e) => e.enabled);
    if (!victim) return "skipped: no enabled extension to toggle";
    const off = await d.extControl("disable", victim.id);
    if (off !== true) throw new Error(`disable refused: ${off}`);
    if ((await d.extensions()).find((e) => e.id === victim.id)?.enabled) {
      throw new Error(`${victim.id} still reports enabled after disable`);
    }
    const on = await d.extControl("enable", victim.id);
    if (on !== true) throw new Error(`re-enable refused: ${on}`);
    if (!(await d.extensions()).find((e) => e.id === victim.id)?.enabled) {
      throw new Error(`${victim.id} did not come back - the sweep left the profile changed`);
    }
    // An unknown id is an ordinary answer, not a throw, and it must NOT be
    // reported as success.
    const bogus = await d.extControl("disable", "no.such.extension");
    if (bogus === true)
      throw new Error("extControl claimed to disable an extension that is not installed");
    return `${victim.id} off and back on`;
  });

  // Settings were the last blind spot: the Settings page is a separate webview
  // no tool driving the main window can read or click, so this goes through the
  // store. Restored to whatever it was, for the same reason as above.
  await check("settings() reads, setSetting() writes, live", async () => {
    const before = await d.settings();
    if (typeof before !== "object" || !("theme" in before)) {
      throw new Error(`settings() returned ${JSON.stringify(before).slice(0, 80)}`);
    }
    // No secret may ever appear here. API keys live in the OS keyring, and a
    // key-shaped preference added later would leak into every agent's context.
    const leaked = Object.keys(before).filter((k) => /key|secret|token|password/i.test(k));
    if (leaked.length) throw new Error(`settings() exposes ${leaked.join(", ")}`);

    const original = before.editorFontSize;
    const target = original === 15 ? 16 : 15;
    const wrote = await d.setSetting("editorFontSize", target);
    if (wrote !== true) throw new Error(`setSetting refused: ${wrote}`);
    if ((await d.settings()).editorFontSize !== target) {
      throw new Error("the write did not reach the live store");
    }
    await d.setSetting("editorFontSize", original);

    // An unknown key and a wrong type are both answers, not crashes.
    if ((await d.setSetting("noSuchPreference", 1)) === true) {
      throw new Error("setSetting accepted a key that is not a preference");
    }
    if ((await d.setSetting("vimMode", "banana")) === true) {
      throw new Error("setSetting accepted a string for a boolean preference");
    }
    // …but a stringified value of the RIGHT type must be coerced, because some
    // AI CLIs stringify every tool argument.
    if ((await d.setSetting("editorFontSize", String(original))) !== true) {
      throw new Error('setSetting rejected "15" for a number preference - the coercion is gone');
    }
    return `${Object.keys(before).length} preferences, editorFontSize round-tripped`;
  });

  await check("logs() captures what the window printed", async () => {
    const stamp = `sweep-log-${Date.now().toString(36)}`;
    await d.eval(`console.warn(${JSON.stringify(stamp)}), 1`);
    await wait(300);
    const all = d.logs();
    if (!all.some((l) => l.text.includes(stamp))) {
      throw new Error("a console.warn from this session was not captured");
    }
    if (!d.logs("warn").some((l) => l.text.includes(stamp))) {
      throw new Error("the level filter dropped a warning");
    }
    if (d.logs("error").some((l) => l.text.includes(stamp))) {
      throw new Error("a warning was reported at error level");
    }
    return `${all.length} entries buffered`;
  });

  // `sh()` is the path an agent runs commands through, and it is NOT the path
  // `command()` above exercises: it writes to the PTY instead of synthesising
  // keystrokes, and it decides "done" from the buffer changing rather than from
  // the prompt alone. That difference is the whole check - a prompt-only wait
  // passes instantly against the PREVIOUS prompt and reads the output before it
  // exists, which looks exactly like a command that printed nothing.
  await check("sh() runs a command and returns its output", async () => {
    const stamp = `sh${(await d.eval("performance.now().toFixed(0)")).slice(-5)}`;
    const out = await d.sh(`echo ${stamp}`, { timeout: 15000 });
    if (out.timedOut) throw new Error("timed out waiting for the prompt");
    const hits = out.text.split("\n").filter((l) => l.includes(stamp)).length;
    if (hits < 2) throw new Error(`${hits} occurrence(s) of "${stamp}" in the returned text`);
    return `leaf ${out.leafId}, ${hits} hits`;
  });

  // Chord virtual keys and the syntax of every injected expression are checked
  // in `scripts/mcp/driver-verify.ts` instead. Both are pure, and a check that
  // needs no running app has no business waiting for one.

  // Asserted against the one-pane baseline, so `paneHandle` MUST be -1 here.
  // The version of this that expected an index instead is the bug it now
  // guards: with a single leaf there is no pane group, so the old lookup walked
  // up to the app layout and answered 0, the sidebar's own handle.
  await check("state() reports the live layout", async () => {
    // `buttons: true` because the list is OPT-IN now. It is a discovery list -
    // 60+ aria-labels, several hundred tokens of an agent's context - and
    // `state` is the verb an agent is told to call constantly, so it is fetched
    // deliberately rather than on every snapshot.
    const s = await d.state({ buttons: true });
    if (s.leaves.length !== base.leaves)
      throw new Error(`leaves ${s.leaves.length} != ${base.leaves}`);
    if (s.tabs.length !== base.tabs) throw new Error(`tabs ${s.tabs.length} != ${base.tabs}`);
    // A tab with no label is a real regression and an easy one to miss: the
    // snapshot still LOOKS right, and every later "switch to the X tab" has
    // nothing to match on.
    if (s.tabs.some((t) => !t.label)) throw new Error(`unlabelled tab: ${JSON.stringify(s.tabs)}`);
    if (s.paneHandle !== -1)
      throw new Error(`paneHandle ${s.paneHandle} with one pane, expected -1`);
    if (s.dialog) throw new Error(`a dialog is open: ${s.dialog}`);
    if (!s.buttons?.length) throw new Error("no aria-labelled buttons found");
    // …and the default must NOT carry them, or the saving is imaginary.
    // `!= null` on purpose: an absent property crosses CDP as undefined, but a
    // serializer that chose null instead would be just as absent, and failing
    // on that would be this check being wrong rather than the code.
    if ((await d.state()).buttons != null) {
      throw new Error("state() returned `buttons` without being asked - the opt-in is not opt-in");
    }
    // `panes` is the model view - every pane in EVERY tab, where `leaves` is
    // only what the DOM has rendered. A pane list shorter than the rendered one
    // means the surface is missing, or the tab tree lost a leaf.
    if (!s.panes.length) throw new Error(`panes unavailable: ${s.tediError ?? "none"}`);
    if (s.panes.length < s.leaves.length) {
      throw new Error(`${s.panes.length} panes but ${s.leaves.length} rendered leaves`);
    }
    if (
      !s.panes.every((p) => typeof p.leafId === "number" && p.kind && typeof p.tabId === "number")
    ) {
      throw new Error(`a pane row is missing its identity: ${JSON.stringify(s.panes[0])}`);
    }
    return `${s.leaves.length} leaf, "${s.tabs[0].label}", ${s.buttons.length} buttons, focusLeaf ${s.focusLeaf}`;
  });

  // …and once split, it must find one. Same call, opposite expectation: this is
  // the pair that proves the index tracks the layout instead of a guess.
  await check(
    "state().paneHandle finds the splitter once split",
    async () => {
      await d.cmd("pane.splitRight");
      await wait(1600);
      const s = await d.state();
      if (s.paneHandle < 0) throw new Error(`no pane splitter with ${s.leaves.length} leaves`);
      const all = await n("[data-slot=resizable-handle]");
      return `handle ${s.paneHandle} of ${all}, ${s.leaves.length} leaves`;
    },
    async () => {
      while ((await leaves()) > base.leaves) {
        await d.click('button[aria-label="Close pane"]', {
          nth: Math.max(0, (await leaves()) - 1),
        });
        await wait(1200);
      }
    },
  );

  // --- tabs ---------------------------------------------------------------
  await check(
    "tab.new opens a tab",
    async () => {
      await d.cmd("tab.new");
      await wait(1500);
      const now = await tabs();
      if (now !== base.tabs + 1) throw new Error(`tabs ${base.tabs} -> ${now}`);
      return `${base.tabs} -> ${now}`;
    },
    async () => {
      while ((await tabs()) > base.tabs) {
        await d.cmd("tab.close");
        await wait(900);
      }
    },
  );

  await check("tab.prev / tab.next switch tabs", async () => {
    await d.cmd("tab.new");
    await wait(1500);
    const active = () =>
      d.eval(
        `document.querySelector('[data-tab-id][data-state=active],[data-tab-id][aria-selected=true]')?.getAttribute('data-tab-id') ?? null`,
      );
    const start = await active();
    await d.cmd("tab.prev");
    await wait(800);
    const prev = await active();
    await d.cmd("tab.next");
    await wait(800);
    const back = await active();
    while ((await tabs()) > base.tabs) {
      await d.cmd("tab.close");
      await wait(900);
    }
    if (start === prev) throw new Error("tab.prev did not move");
    return `${start} -> ${prev} -> ${back}`;
  });

  // --- panes --------------------------------------------------------------
  await check(
    "pane.splitRight / splitDown add leaves",
    async () => {
      await d.cmd("pane.splitRight");
      await wait(2200);
      const right = await leaves();
      await d.cmd("pane.splitDown");
      await wait(2200);
      const down = await leaves();
      if (right <= base.leaves || down <= right)
        throw new Error(`${base.leaves} -> ${right} -> ${down}`);
      return `${base.leaves} -> ${right} -> ${down}`;
    },
    async () => {
      for (let i = 0; i < 6 && (await leaves()) > base.leaves; i++) {
        await d.cmd("terminal.close");
        await wait(900);
      }
    },
  );

  await check(
    "pane.focusNext moves the active pane and the keys with it",
    async () => {
      await d.cmd("pane.splitRight");
      await wait(2600);
      // Type into the new pane first. Straight after a split the shell has not
      // been touched yet, and the focus the split leaves behind is not the same
      // as the focus a used terminal holds; without this the check measures a
      // state no human is ever in.
      await d.command("clear", { delay: 10 });
      await wait(1200);
      // Which leaf HOLDS focus, not what `document.activeElement` closest-matches:
      // tabs never unmount, so leaves from other tabs are in the DOM too and only
      // one of them can actually contain the focused element.
      const holder = () =>
        d.eval(
          `[...document.querySelectorAll('[data-pane-leaf]')].find(e=>e.contains(document.activeElement))?.getAttribute('data-pane-leaf') ?? null`,
        );
      const before = await holder();
      await d.cmd("pane.focusNext");
      await wait(1800);
      const after = await holder();
      if (!after || after === before) throw new Error(`focus ${before} -> ${after}`);
      return `focus ${before} -> ${after}`;
    },
    async () => {
      for (let i = 0; i < 4 && (await leaves()) > base.leaves; i++) {
        await d.cmd("terminal.close");
        await wait(900);
      }
    },
  );

  await check(
    "splitter drag resizes a pane",
    async () => {
      await d.cmd("pane.splitRight");
      await wait(2200);
      const xs = () =>
        d.eval(
          `[...document.querySelectorAll('[data-slot=resizable-handle]')].map(e=>Math.round(e.getBoundingClientRect().x)).join(',')`,
        );
      const before = await xs();
      const nth = await paneHandle();
      if (nth < 0) throw new Error("no splitter inside the pane group");
      await d.drag("[data-slot=resizable-handle]", -160, 0, { nth });
      await wait(800);
      const after = await xs();
      if (before === after) throw new Error(`handles unmoved (${before})`);
      return `handle ${nth}: ${before} -> ${after}`;
    },
    async () => {
      for (let i = 0; i < 4 && (await leaves()) > base.leaves; i++) {
        await d.cmd("terminal.close");
        await wait(900);
      }
    },
  );

  // --- float a pane into its own window -----------------------------------
  // Opt in with SWEEP_FLOAT=1. Floating passed twice earlier and then stopped
  // producing a window at all, with no error in the log and no window at the OS
  // level either. Five explanations were tested and none held: a single-pane
  // tab, stale float state cleared by a page reload, stale state cleared by a
  // full app restart, the CDP target simply not being exposed, and a jammed
  // renderer. Twice the app exited moments after the click. Until someone can
  // reproduce it deliberately, a default sweep should not depend on it.
  if (!process.env.SWEEP_FLOAT) {
    skipped.push("float a pane: regressed mid-session, unexplained, SWEEP_FLOAT=1 to try it");
  } else
    await check(
      "a pane floats into its own window",
      async () => {
        const { listTargets } = await import("./driver.mjs");
        const port = Number(process.env.TEDI_DEBUG_PORT) || 9222;
        // Assert a float.html target appears, not that the target COUNT grew: a
        // Settings window left open by an earlier run already inflates the count
        // and turns a working float into a false failure.
        const floats = async () =>
          (await listTargets(port)).filter((t) => /float\.html/.test(t.url)).length;
        // Refuse rather than force-close an orphan. Closing a float window from
        // CDP with `window.close()` bypasses TEDI's own dock-back path, and after
        // doing that, floating stopped working entirely until the app was
        // restarted: a frontend reload did not clear it, so whatever is left
        // stale lives on the Rust side. Dismiss a stray float window from the app,
        // by closing its source pane.
        const before = await floats();
        if (before > 0) {
          throw new Error("a float window is already open; close its source pane and re-run");
        }
        // Split first: floating is refused when the tab has a single pane, since
        // there would be nothing left behind.
        await d.cmd("pane.splitRight");
        await wait(2400);
        // Tabs never unmount, so the DOM also holds the float buttons of panes in
        // INACTIVE tabs. Clicking one of those does nothing. Take the first whose
        // pane is actually laid out.
        const floatBtn = await d.eval(`(() => {
        const all = [...document.querySelectorAll('button[aria-label="Float pane in its own window"]')];
        return all.findIndex((b) => {
          const leaf = b.closest('[data-pane-leaf]');
          const r = leaf?.getBoundingClientRect();
          return !!r && r.width > 200 && r.height > 200 && r.x >= 0 && r.x < innerWidth;
        });
      })()`);
        if (floatBtn < 0) throw new Error("no float button inside a laid-out pane");
        await d.click('button[aria-label="Float pane in its own window"]', { nth: floatBtn });
        // Poll: the float window is a whole new webview and does not always show
        // up inside a fixed wait.
        let after = before;
        for (let i = 0; i < 15 && after <= before; i++) {
          await wait(1000);
          after = await floats();
        }
        if (after <= before) {
          const all = (await listTargets(port)).map((t) => t.title).join(", ");
          throw new Error(`float windows ${before} -> ${after}; targets: ${all}`);
        }
        return `float windows ${before} -> ${after}`;
      },
      async () => {
        // Dismiss it by closing the SOURCE pane in the main window. The float
        // window itself renders no buttons at all, so there is nothing to click
        // over there.
        const { listTargets } = await import("./driver.mjs");
        const port = Number(process.env.TEDI_DEBUG_PORT) || 9222;
        for (let i = 0; i < 6; i++) {
          if (!(await listTargets(port)).some((t) => /float\.html/.test(t.url))) break;
          const last = Math.max(0, (await leaves()) - 1);
          await d.click('button[aria-label="Close pane"]', { nth: last });
          await wait(1500);
        }
      },
    );

  // --- view ---------------------------------------------------------------
  await check(
    "sidebar.toggle collapses and restores the sidebar",
    async () => {
      const before = await sidebarWidth();
      await d.cmd("sidebar.toggle");
      await wait(1000);
      const collapsed = await sidebarWidth();
      if (collapsed === before) throw new Error(`width unchanged (${before})`);
      return `${before}px -> ${collapsed}px`;
    },
    async () => {
      if ((await sidebarWidth()) === 0) {
        await d.cmd("sidebar.toggle");
        await wait(1000);
      }
    },
  );

  await check(
    "view.zoomIn / zoomOut / zoomReset change --content-zoom",
    async () => {
      const before = await zoom();
      await d.cmd("view.zoomIn");
      await wait(900);
      const inZ = await zoom();
      await d.cmd("view.zoomOut");
      await wait(900);
      const outZ = await zoom();
      if (inZ === before || outZ === inZ) throw new Error(`${before} -> ${inZ} -> ${outZ}`);
      return `${before} -> ${inZ} -> ${outZ}`;
    },
    async () => {
      await d.cmd("view.zoomReset");
      await wait(900);
    },
  );

  // --- command palette ----------------------------------------------------
  const paletteInput = () =>
    d.eval(
      "[...document.querySelectorAll('input')].findIndex(i=>/Type a command/i.test(i.placeholder||''))",
    );

  await check(
    "command palette opens, filters and closes",
    async () => {
      await d.cmd("commandPalette.open");
      await wait(1000);
      const i = await paletteInput();
      if (i < 0) throw new Error("palette input not found");
      await d.click("input", { nth: i });
      await d.type("split", { delay: 25 });
      await wait(800);
      const rows = await n("[cmdk-item],[role=option]");
      if (!rows) throw new Error('no rows for "split"');
      return `${rows} rows`;
    },
    async () => {
      await d.keys("Escape");
      await wait(700);
    },
  );

  await check(
    "palette @ finds a file",
    async () => {
      await d.cmd("commandPalette.open");
      await wait(1000);
      const i = await paletteInput();
      await d.click("input", { nth: i });
      await d.type("@vite.config", { delay: 25 });
      await wait(1000);
      const hits = await d.eval(
        `[...document.querySelectorAll('[cmdk-item],[role=option]')].map(e=>e.textContent.trim()).slice(0,2)`,
      );
      if (!hits.length) throw new Error("no file hits");
      return JSON.stringify(hits);
    },
    async () => {
      await d.keys("Escape");
      await wait(700);
    },
  );

  // --- explorer -----------------------------------------------------------
  await check(
    "explorer.search opens the tree filter",
    async () => {
      const before = await n("input");
      await d.cmd("explorer.search");
      await wait(1000);
      const after = await n("input");
      if (after <= before) throw new Error(`inputs ${before} -> ${after}`);
      return `inputs ${before} -> ${after}`;
    },
    async () => {
      await d.keys("Escape");
      await wait(600);
    },
  );

  await check(
    "explorer.grep opens search in files",
    async () => {
      const before = await n("input");
      await d.cmd("explorer.grep");
      await wait(1200);
      const after = await n("input");
      if (after <= before) throw new Error(`inputs ${before} -> ${after}`);
      return `inputs ${before} -> ${after}`;
    },
    async () => {
      await d.keys("Escape");
      await wait(600);
    },
  );

  // A named folder, not `nth: 0`: the first row is `.agents`, which is empty, so
  // expanding it correctly adds nothing and the check would read as a failure.
  const FOLDER = '[data-fs-kind=dir][data-fs-path$="/scripts"]';
  await check(
    "clicking a folder expands it",
    async () => {
      const before = await n("[data-fs-path]");
      await d.click(FOLDER);
      await wait(1500);
      const after = await n("[data-fs-path]");
      if (after === before) throw new Error(`rows unchanged (${before})`);
      return `rows ${before} -> ${after}`;
    },
    async () => {
      await d.click(FOLDER);
      await wait(1000);
    },
  );

  // --- editor -------------------------------------------------------------
  await check("new file, open, type, save, read back", async () => {
    await d.click("button[aria-label='New file']");
    await wait(1000);
    await d.type(SCRATCH, { delay: 30 });
    await d.keys("Enter");
    // Poll for the row: the file lands on disk immediately but the tree can take
    // a good while longer to show it, and a fixed wait turns that into a failure
    // that reads as "creating a file does not work".
    const row = `button[data-fs-path$="${SCRATCH}"]`;
    for (let i = 0; i < 20 && (await n(row)) === 0; i++) await wait(1000);
    if ((await n(row)) === 0) throw new Error(`${SCRATCH} never appeared in the tree`);
    await d.click(row);
    await d.waitFor(".cm-content");
    await wait(1000);
    const nth = (await editors()) - 1;
    await d.click(".cm-content", { nth });
    await d.keys("Ctrl+A", "Delete");
    await d.type("# sweep", { delay: 30 });
    await d.keys("Ctrl+S");
    await wait(1800);
    const shown = await d.text(".cm-content", { nth });
    if (!shown.includes("# sweep")) throw new Error(`editor shows ${JSON.stringify(shown)}`);
    return JSON.stringify(shown);
  });

  // `openFile()` reaches a path the tree has not expanded, and `editors()` reads
  // the LIVE buffer. Both exist because the DOM route is wrong rather than
  // merely awkward: CodeMirror virtualises, so `text('.cm-content')` returns
  // only the scrolled-in window of a long file and looks like the whole thing.
  await check("openFile + editors() round-trip a path and its buffer", async () => {
    const target = `${PROJECT}\\package.json`;
    await d.openFile(target);
    await d.waitFor(".cm-content");
    await wait(1600);
    const open = await d.editors();
    const mine = open.find((e) => e.path.toLowerCase().endsWith("package.json"));
    if (!mine) throw new Error(`package.json not among ${JSON.stringify(open.map((e) => e.path))}`);
    if (!mine.text.includes('"name": "tedi"')) {
      throw new Error(
        `buffer does not look like package.json: ${JSON.stringify(mine.text.slice(0, 80))}`,
      );
    }
    // The point of reading through the editor rather than the DOM: the whole
    // file, not the handful of lines currently painted.
    const domLines = (await d.text(".cm-content", { nth: (await editors()) - 1 })).split(
      "\n",
    ).length;
    const realLines = mine.text.split("\n").length;
    if (realLines <= domLines)
      throw new Error(`editors() saw ${realLines} lines, DOM saw ${domLines}`);
    return `leaf ${mine.leafId}, ${realLines} lines vs ${domLines} in the DOM`;
  });

  // Focus without a click. A click also focuses, but lands a mouse press inside
  // the pane, which in an editor moves the caret to wherever the centre was.
  await check("focusPane() moves keyboard focus without clicking", async () => {
    const before = await d.focusedLeaf();
    const other = (await d.state()).leaves.find((l) => l.id !== before);
    if (!other) throw new Error("only one leaf open");
    await d.focusPane(other.id);
    await wait(600);
    const now = await d.focusedLeaf();
    if (now !== other.id) throw new Error(`focus is ${now}, wanted ${other.id}`);
    return `${before} -> ${now}`;
  });

  await check(
    "editor.findReplace opens the find bar",
    async () => {
      const before = await n("input");
      await d.cmd("editor.findReplace");
      await wait(1000);
      const after = await n("input");
      if (after <= before) throw new Error(`inputs ${before} -> ${after}`);
      return `inputs ${before} -> ${after}`;
    },
    async () => {
      await d.keys("Escape");
      await wait(600);
    },
  );

  // Ctrl+/ and not `cmd("editor.toggleComment")`: CodeMirror's own keymap owns
  // this one, so it registers no handler in the shared registry. Same shape as
  // `ai.send`, where the composer owns Enter. Both are reachable by key only.
  await check("Ctrl+/ comments a line (key-owned, no registry handler)", async () => {
    const nth = (await editors()) - 1;
    if (nth < 0) throw new Error("no editor open");
    await d.click(".cm-content", { nth });
    await wait(600);
    const registered = await d.eval("window.__tedi.hasCommand('editor.toggleComment')");
    const before = await d.text(".cm-content", { nth });
    await d.keys("Ctrl+/");
    await wait(1100);
    const after = await d.text(".cm-content", { nth });
    if (before === after) throw new Error(`buffer unchanged: ${JSON.stringify(before)}`);
    await d.keys("Ctrl+/");
    await wait(900);
    return `registry=${registered}, ${JSON.stringify(before)} -> ${JSON.stringify(after)}`;
  });

  // --- source control (read only) -----------------------------------------
  await check("scm.open shows the working tree", async () => {
    const before = await tabs();
    await d.cmd("scm.open");
    await wait(3000);
    const after = await tabs();
    const body = await d.eval("document.body.innerText.slice(0, 5000)");
    if (after <= before && !/source control|changes|staged/i.test(body)) {
      throw new Error("no SCM surface appeared");
    }
    return `tabs ${before} -> ${after}`;
  });

  // --- AI -----------------------------------------------------------------
  await check(
    "ai.toggle opens the composer",
    async () => {
      await d.cmd("ai.toggle");
      await wait(1600);
      const open = await d.eval(
        "[...document.querySelectorAll('textarea')].some(t=>(t.placeholder||'').startsWith('Ask'))",
      );
      if (!open) throw new Error("composer not found");
      return "composer present";
    },
    async () => {
      const open = await d.eval(
        "[...document.querySelectorAll('textarea')].some(t=>(t.placeholder||'').startsWith('Ask'))",
      );
      if (open) {
        await d.cmd("ai.toggle");
        await wait(900);
      }
    },
  );

  // --- header + second webview -------------------------------------------
  await check("search.focus focuses the header search", async () => {
    await d.cmd("search.focus");
    await wait(900);
    const el = await d.eval(
      "(() => { const a = document.activeElement; return (a?.tagName || '') + ':' + (a?.placeholder || ''); })()",
    );
    if (!/input/i.test(el)) throw new Error(`focus is ${el}`);
    return el;
  });

  await check("settings opens as its own webview", async () => {
    await d.cmd("settings.open");
    const { listTargets } = await import("./driver.mjs");
    const port = Number(process.env.TEDI_DEBUG_PORT) || 9222;
    // Poll: a cold Settings window shows up as `about:blank` first and only then
    // navigates, so a fixed wait catches it half-born.
    let list = [];
    for (let i = 0; i < 20; i++) {
      await wait(1000);
      list = await listTargets(port);
      if (list.some((t) => /settings\.html/.test(t.url))) break;
    }
    const settings = list.find((t) => /settings\.html/.test(t.url));
    if (!settings) throw new Error(`targets: ${list.map((t) => t.url).join(", ")}`);
    return `${list.length} targets, incl. ${settings.title}`;
  });

  // The keymap lives in the Settings webview, so it has to be read there: the
  // main window never mentions it and checking here reads as a false failure.
  await check("shortcuts.open shows the keymap in the Settings webview", async () => {
    await d.cmd("shortcuts.open");
    await wait(2500);
    const { connect } = await import("./driver.mjs");
    const s = await connect({
      port: Number(process.env.TEDI_DEBUG_PORT) || 9222,
      target: "settings.html",
    });
    try {
      const body = await s.eval("document.body.innerText.slice(0,4000)");
      if (!/shortcut/i.test(body)) throw new Error("Settings does not show shortcuts");
      return "keymap present in Settings";
    } finally {
      await s.close();
    }
  });

  // --- teardown -----------------------------------------------------------
  await check("teardown returns to baseline", async () => {
    await normalise();
    return `tabs ${await tabs()}, leaves ${await leaves()}, sidebar ${await sidebarWidth()}px`;
  });

  skipped.push("git staging / commit / discard: mutates the working tree");
  skipped.push("workspace create / delete: mutates saved workspaces");
  skipped.push("SSH connect: needs a live host and credentials");
  skipped.push("extension install / uninstall: mutates the profile");
  skipped.push("AI send: calls the configured provider and spends credit");
  skipped.push(`${SCRATCH}: left on disk, delete it after reading the report`);

  const pass = results.filter((r) => r.ok).length;
  console.log("\n=== control sweep ===");
  for (const r of results)
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}\n        ${r.evidence}`);
  console.log(`\n${pass}/${results.length} passed`);
  console.log("not exercised:");
  for (const s of skipped) console.log(`  - ${s}`);
  return { pass, total: results.length };
}
