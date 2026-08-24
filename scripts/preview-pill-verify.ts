/**
 * Self-check for the dev-server preview pill: it must be visible from anywhere,
 * and only while the port actually answers.
 * Run: `npx tsx scripts/preview-pill-verify.ts`.
 *
 * The pill is assembled from four files that nothing else ties together, and
 * every joint fails SILENTLY - the pill simply stops appearing, or keeps
 * offering a server that died:
 *
 *  1. LIVENESS IS ONE AUTHORITY. `useProjectUrl` must report its url whether or
 *     not it answers. It probes only on an `explorerRoot` change, so gating
 *     there means a server started after the user stops navigating can never be
 *     discovered - the original bug, in the config-url source.
 *  2. THE POLL MUST NOT STOP ON DEAD. `useLiveUrl` never writes back to its
 *     caller, so a restarted server can only return via the next tick. Its
 *     effect must also key on the JOINED candidate string: the caller's memo
 *     recomputes on every `tabs` change and would otherwise rebuild the timer.
 *  3. PLACEMENT. The globe sits on the header of the pane that PRINTED the url,
 *     beside float, and nowhere else. Moving it off the status bar was a
 *     deliberate reversal (v0.4.27): the pane header cannot be always-visible,
 *     since WorkspaceArea blanks the pane stack on any non-pane tab, and that
 *     limitation is accepted so the url sits next to the terminal that printed
 *     it. Anchoring it to that terminal rather than to focus came next
 *     (v0.4.28), because a server keeps running when the pane loses the caret.
 *     What must not happen is TWO copies with different gates, so the
 *     status-bar pill is asserted gone.
 *  4. SSH EMITS A DIFFERENT URL THAN IT DEDUPES ON. Over SSH the shell prints a
 *     REMOTE address and the app is handed the TUNNELLED local one. Re-attach
 *     must replay what was EMITTED; replaying the printed one offers a local
 *     port the tunnel never bound, which a liveness probe cannot catch (an
 *     unrelated local service on that port answers just fine).
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findLocalUrl } from "../src/modules/terminal/lib/detectUrl";
import { remotePortOf, toLocalUrl } from "../src/modules/terminal/lib/forwardUrl";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

console.log("1. a wildcard-bound server survives the whole pipeline");
{
  // Behavioural, not a source grep: this is the one path that crosses three
  // modules, and `0.0.0.0` used to die silently at the probe (`port_is_open`
  // refuses every non-loopback address, and Rust counts only 127/8 as loopback).
  const printed = findLocalUrl("INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C)");
  assert(printed === "http://127.0.0.1:8000", `local: rewritten to loopback (got ${printed})`);

  // Over SSH the SAME string is tunnelled. The rewrite must not disturb the port
  // the tunnel binds, nor the authority swap that follows.
  assert(remotePortOf(printed!) === 8000, "ssh: the remote port still reads as 8000");
  assert(
    toLocalUrl(printed!, 49001) === "http://127.0.0.1:49001/",
    "ssh: the authority swap still produces the tunnel's local end",
  );

  // A path must survive both steps, since that is what makes a url worth opening.
  const withPath = findLocalUrl("Listening on http://0.0.0.0:3000/admin");
  assert(withPath === "http://127.0.0.1:3000/admin", "the path survives the rewrite");
  assert(
    toLocalUrl(withPath!, 5000) === "http://127.0.0.1:5000/admin",
    "and survives the tunnel swap",
  );
}

console.log("2. liveness has exactly one authority, and it never stops polling");
{
  const projectUrl = read("src/app/hooks/useProjectUrl.ts");
  assert(
    /export function useLiveUrl\(urls: string\[\]\): string \| null/.test(projectUrl),
    "useLiveUrl takes an ordered candidate list",
  );
  // The fall-through is the point: a stopped `npm run dev` must not mask a live
  // vhost sitting behind it in the priority order.
  assert(
    /for \(const url of urlsRef\.current\)[\s\S]{0,200}?await isUp\(url\)[\s\S]{0,160}?setLive\(url\)/.test(
      projectUrl,
    ),
    "it walks the candidates and takes the first that answers",
  );
  assert(
    /strikes\+\+;\s*\n\s*if \(strikes >= DEAD_STRIKES\) setLive\(null\)/.test(projectUrl),
    "and only drops the url after DEAD_STRIKES consecutive dead rounds",
  );
  // If the effect keyed on the array it would rebuild the interval on every
  // `tabs` change, which is every leaf add / close / focus.
  assert(
    /const key = urls\.join\("\|"\)/.test(projectUrl) && /\}, \[key\]\);/.test(projectUrl),
    "the effect keys on the joined string, not the array identity",
  );
  assert(
    /document\.visibilityState === "visible"/.test(projectUrl) &&
      /window\.addEventListener\("blur", onBlur\)/.test(projectUrl),
    "the poll is gated on window visibility like the git and file-tree polls",
  );
  // The regression that would quietly undo the whole feature.
  assert(
    !/const up = await isUp\(url\);\s*\n\s*if \(alive\) cb\.current\(up \? url : null\)/.test(
      projectUrl,
    ),
    "useProjectUrl no longer gates its own report on a one-shot probe",
  );
  assert(
    /const detectedBrowserUrl = useLiveUrl\(previewCandidates\)/.test(
      read("src/app/hooks/useActiveLeafSurface.ts"),
    ),
    "and the app's single detected url comes out of useLiveUrl",
  );
}

console.log("3. the globe sits on the pane that PRINTED the url, not the focused one");
{
  // PLACEMENT REVERSED ON REQUEST (v0.4.27). It used to sit in the status bar
  // precisely because that is always visible, and this trade is now accepted
  // knowingly: `WorkspaceArea` blanks the whole pane stack on any Source
  // Control, diff or extension tab, so the offer is unreachable from those.
  // The url is most useful next to the terminal that printed it, and there is
  // no second, differently-gated copy to disagree with.
  const paneTree = read("src/modules/panes/PaneTreeView.tsx");
  assert(/\bGlobe\b/.test(paneTree), "PaneTreeView imports the globe icon");
  // Anchored to a leaf id, NOT to `onlyHere`: focus is not what makes a dev
  // server run, so the offer must not hop from header to header (or blink out)
  // as the user clicks around a split. Still exactly one globe, because leaf
  // ids are unique and the id is resolved into the visible tab before it here.
  assert(
    /\{node\.id === previewLeafId && previewUrl && onOpenPreview && \(/.test(paneTree),
    "it renders on the pane that printed the url, not on whichever has focus",
  );
  assert(!/\{onlyHere && previewUrl/.test(paneTree), "and no focus gate is left on it");
  // The prop rides PaneDndContext, like every other pane-header action.
  assert(
    /previewUrl\?: string \| null;/.test(paneTree) &&
      /previewLeafId\?: number \| null;/.test(paneTree) &&
      /onOpenPreview\?: \(\) => void;/.test(paneTree),
    "the context carries the url, its pane and the opener",
  );

  const statusBar = read("src/modules/statusbar/StatusBar.tsx");
  assert(!/PreviewUrlPill/.test(statusBar), "the status-bar pill is gone");
  assert(!/\bGlobe\b/.test(statusBar), "and so is its Globe import");
  assert(!/previewUrl/.test(statusBar), "StatusBar no longer takes the url at all");

  // The chain App -> WorkspaceArea -> PaneStack -> PaneTreeView must be whole,
  // or the globe silently never appears.
  assert(
    /previewUrl=\{detectedBrowserUrl\}/.test(read("src/app/App.tsx")),
    "App feeds it the live url",
  );
  assert(
    /previewLeafId=\{previewLeafId\}/.test(read("src/app/App.tsx")),
    "App feeds it the pane that printed it",
  );
  for (const rel of ["src/app/components/WorkspaceArea.tsx", "src/modules/panes/PaneStack.tsx"]) {
    assert(
      /previewUrl=\{previewUrl\}/.test(read(rel)) &&
        /previewLeafId=\{previewLeafId\}/.test(read(rel)),
      `${rel} passes both through`,
    );
  }
  // The resolution itself: the printing leaf while it is in the visible tab,
  // else the active leaf - a project-config url belongs to no pane, and a url
  // printed in ANOTHER tab should follow the user there rather than vanish.
  assert(
    /previewLeafId = useMemo\([\s\S]{0,800}?return inActiveTab \? owner : activeLeafIdInTab;/.test(
      read("src/app/hooks/useActiveLeafSurface.ts"),
    ),
    "useActiveLeafSurface resolves the owning pane, falling back to the active leaf",
  );
}

console.log("4. an SSH leaf replays the url it EMITTED, not the one it printed");
{
  const state = read("src/modules/terminal/lib/sessionState.ts");
  assert(/lastEmittedUrl: string \| null;/.test(state), "the session carries both urls");

  const pty = read("src/modules/terminal/lib/pty-lifecycle.ts");
  // Get this branch backwards and every re-attach offers the REMOTE address.
  assert(
    /s\.lastDetectedUrl = url;\s*\n\s*s\.lastEmittedUrl = local;/.test(pty),
    "the SSH branch dedupes on the printed url and emits the tunnelled one",
  );
  assert(
    /s\.lastDetectedUrl = url;\s*\n\s*s\.lastEmittedUrl = url;/.test(pty),
    "the local branch stores the same url in both",
  );
  assert(
    /s\.lastEmittedUrl = null;/.test(pty),
    "a respawn clears it, so a dead shell stops offering its old port",
  );

  const lifecycle = read("src/modules/terminal/lib/session-lifecycle.ts");
  assert(
    /callbacks\.onDetectedLocalUrl\?\.\(s\.lastEmittedUrl\)/.test(lifecycle),
    "re-attach replays lastEmittedUrl",
  );
  assert(
    !/callbacks\.onDetectedLocalUrl\?\.\(s\.lastDetectedUrl\)/.test(lifecycle),
    "and never lastDetectedUrl (over SSH that is a port this machine never bound)",
  );
}

// `throw` (not process.exit) for a non-zero exit, matching the other verify scripts.
if (failed > 0) throw new Error(`preview-pill-verify: ${failed} check(s) failed`);
console.log("\npreview-pill-verify: all checks passed");
