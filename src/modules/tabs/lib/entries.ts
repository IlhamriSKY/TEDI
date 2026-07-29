import { basename } from "@/lib/path";
import { type PaneLeaf, isRemoteEditorLeaf, leaves } from "@/modules/terminal/lib/panes";
import { type ExtensionTabState } from "./useTabs";
import { type SshConnection } from "@/modules/ssh/connections";
import { type SshStatus } from "@/modules/ssh/status";
import { type AiCliStatus } from "@/modules/terminal/lib/aiCliStatus";
import type { Tab } from "./useTabs";
import { titleFromUrl } from "./tabHelpers";

/**
 * Tab strip entries: one per pane for pane tabs, one per tab for preview
 * and ai-diff. Clicking a pane entry focuses that pane; clicking a
 * preview/ai-diff entry activates that tab.
 */
type EntryBase = {
  /** Composite key like "tab-3" or "leaf-7". */
  key: string;
  /** Owning tab id. */
  tabId: number;
  /** Display label. */
  label: string;
  /** Italic for preview/transient. */
  italic?: boolean;
  /** Yellow dot for unsaved edits. */
  dirty?: boolean;
};

export type PaneEntry = EntryBase & {
  kind: "pane-leaf";
  leafId: number;
  leafKind: "terminal" | "editor" | "browser" | "extension-panel";
  /** Current page URL for browser leaves. Drives the tab-strip favicon. */
  browserUrl?: string;
  /** 1-based FIFO badge number for terminal + browser leaves. For terminals
   *  this is the same identifier the AI sees in `<env>`. */
  ordinal?: number;
  /** Set on terminal leaves bound to a saved SSH host. */
  sshConnectionId?: string;
  /** Latest SSH session status. Drives the colored dot. */
  sshStatus?: SshStatus;
  /** Latest AI CLI status for terminal leaves. Null when no AI CLI is active. */
  aiCliStatus?: AiCliStatus;
  /** Set on editor leaves backed by SFTP. Flips the file icon to a remote variant. */
  remoteHost?: string;
  /** Inherited from the owning tab. Drives the red badge + lock icon. */
  isPrivate?: boolean;
  /** Lifecycle tone for an extension-panel leaf (mirrors the ext tab). Drives
   *  the label text colour, set via `ctx.tabs.setExtensionTabState(...)`. */
  extState?: ExtensionTabState;
};

type StandaloneEntry = EntryBase & {
  kind: "ai-diff" | "git-diff" | "scm";
};

type ExtensionEntry = EntryBase & {
  kind: "ext";
  extensionId: string;
  panelId: string;
  /** Icon hint from the extension. Either `lucide:<Name>` (or legacy
   *  `hugeicon:<Name>`) for an inline icon, or a relative asset path. */
  icon?: string;
  /** Lifecycle tone set by the extension via
   *  `ctx.tabs.setExtensionTabState(...)`. Drives the title text colour. */
  state?: ExtensionTabState;
};

export type Entry = PaneEntry | StandaloneEntry | ExtensionEntry;

/**
 * Background color for the per-tab accent stripe. Emerald for local shell,
 * sky for SSH, brand blue for editor, cyan for preview, violet for AI diff,
 * amber for git diff. Rendered as a `<span>` (not `::after`) because the
 * primitive `TabsTrigger` already uses `::after` with equal specificity.
 * Keep strings as full literals for Tailwind's JIT.
 */
export function tabAccentClass(e: Entry): string {
  if (e.kind === "pane-leaf") {
    // Private tabs win the accent regardless of leaf kind so the red stripe
    // is the dominant signal. AI cannot see this tab. Uses the `destructive`
    // (danger) token, matching the private LABEL text elsewhere, rather than
    // the AI-CLI `icon-blocked` status color.
    if (e.isPrivate) return "bg-destructive";
    if (e.leafKind === "terminal") {
      return e.sshConnectionId
        ? "bg-[color:var(--tedi-tab-ssh)]"
        : "bg-[color:var(--tedi-tab-terminal)]";
    }
    if (e.leafKind === "browser") return "bg-[color:var(--tedi-tab-browser)]";
    // Extension panel: reuse the SSH/extension accent (sky) so it reads as a
    // "dev tool" leaf, matching the extension tab strip color.
    if (e.leafKind === "extension-panel") return "bg-[color:var(--tedi-tab-ssh)]";
    return "bg-[color:var(--tedi-tab-editor)]";
  }
  if (e.kind === "ai-diff") return "bg-[color:var(--tedi-tab-ai-diff)]";
  if (e.kind === "git-diff") return "bg-[color:var(--tedi-tab-git-diff)]";
  if (e.kind === "scm") return "bg-[color:var(--tedi-tab-git-diff)]";
  // Extension tab. Reuse the SSH accent (sky blue) so workbench-style
  // extensions read as "remote-ish dev tools" next to terminal tabs.
  return "bg-[color:var(--tedi-tab-ssh)]";
}

/** Tailwind `text-*` class for an extension tab title. Mirrors the SSH
 *  palette so workbench-style extensions read consistently: connecting
 *  pulses yellow, connected is green, disconnected/error is red. Returns
 *  "" for idle/unknown so the label inherits the tab's default colour. */
export function extensionStateLabelClass(state: ExtensionTabState | undefined): string {
  if (!state) return "";
  switch (state) {
    case "connecting":
    case "reconnecting":
      return "text-icon-working animate-pulse";
    case "connected":
      return "text-icon-idle";
    case "disconnected":
    case "error":
      return "text-icon-blocked";
    case "idle":
      return "";
  }
}

function entryLabel(
  leaf: PaneLeaf,
  fallbackCwd: string | undefined,
  sshHosts: Map<string, SshConnection>,
): string {
  if (leaf.leafKind === "editor") return basename(leaf.path);
  if (leaf.leafKind === "browser") return leaf.title || titleFromUrl(leaf.url);
  if (leaf.leafKind === "extension-panel") return leaf.title || "panel";
  // SSH leaves: show "ssh:<name>" when the saved connection has a name, else
  // fall back to the host/IP. Bare "ssh" if the connection was deleted.
  if (leaf.sshConnectionId) {
    const conn = sshHosts.get(leaf.sshConnectionId);
    if (!conn) return "ssh";
    return `ssh:${conn.name.trim() || conn.host}`;
  }
  if (leaf.cwd) {
    const b = basename(leaf.cwd);
    if (b) return b;
  }
  if (fallbackCwd) {
    const b = basename(fallbackCwd);
    if (b) return b;
  }
  return "shell";
}

export function buildEntries(
  tabs: Tab[],
  sshHosts: Map<string, SshConnection>,
  sshStatuses?: Map<number, SshStatus>,
  aiCliStatuses?: Map<number, AiCliStatus>,
): Entry[] {
  const out: Entry[] = [];
  for (const t of tabs) {
    if (t.kind === "pane") {
      for (const leaf of leaves(t.paneTree)) {
        const label = entryLabel(leaf, t.cwd, sshHosts);
        const sshConnectionId = leaf.leafKind === "terminal" ? leaf.sshConnectionId : undefined;
        // FIFO ordinal assigned at leaf creation. Preserved through drag,
        // reorder, move-to-group, and workspace restarts. Terminals use the
        // same number the AI sees in the per-turn `<env>` block; browsers have
        // their own independent sequence.
        const ord =
          leaf.leafKind === "terminal" && typeof leaf.terminalOrdinal === "number"
            ? leaf.terminalOrdinal
            : leaf.leafKind === "browser" && typeof leaf.browserOrdinal === "number"
              ? leaf.browserOrdinal
              : undefined;
        const remoteHost =
          leaf.leafKind === "editor" && isRemoteEditorLeaf(leaf)
            ? (leaf.sshHostLabel ?? "remote")
            : undefined;
        out.push({
          kind: "pane-leaf",
          key: `leaf-${leaf.id}`,
          tabId: t.id,
          leafId: leaf.id,
          leafKind: leaf.leafKind,
          browserUrl: leaf.leafKind === "browser" ? leaf.url : undefined,
          label,
          ordinal: ord,
          italic:
            leaf.leafKind === "editor" &&
            (leaf as PaneLeaf & { preview?: boolean }).preview === true,
          dirty:
            leaf.leafKind === "editor" && (leaf as PaneLeaf & { dirty?: boolean }).dirty === true,
          sshConnectionId,
          sshStatus: sshConnectionId ? sshStatuses?.get(leaf.id) : undefined,
          // AI CLI status on SSH leaves too. Detector runs on the byte stream regardless of PTY locality.
          aiCliStatus: leaf.leafKind === "terminal" ? aiCliStatuses?.get(leaf.id) : undefined,
          remoteHost,
          isPrivate: leaf.private === true,
          extState: leaf.leafKind === "extension-panel" ? leaf.state : undefined,
        });
      }
      continue;
    }
    if (t.kind === "ai-diff") {
      out.push({
        kind: "ai-diff",
        key: `tab-${t.id}`,
        tabId: t.id,
        label: t.title,
      });
      continue;
    }
    if (t.kind === "git-diff") {
      out.push({
        kind: "git-diff",
        key: `tab-${t.id}`,
        tabId: t.id,
        label: t.title,
      });
      continue;
    }
    if (t.kind === "scm") {
      out.push({
        kind: "scm",
        key: `tab-${t.id}`,
        tabId: t.id,
        label: t.title,
      });
      continue;
    }
    // ext: extension-owned tab. Carry icon + ext id forward for rendering.
    out.push({
      kind: "ext",
      key: `tab-${t.id}`,
      tabId: t.id,
      label: t.title,
      extensionId: t.extensionId,
      panelId: t.panelId,
      icon: t.icon,
      state: t.state,
    });
  }
  return out;
}

/**
 * Number of tab-strip entries `buildEntries` would produce, without building
 * them: every leaf of a pane tab (so a split "group" tab contributes all its
 * panes, not 1) plus one for each standalone/extension tab. The workspace
 * badge counts this so it matches the strip exactly instead of treating a
 * multi-pane group as a single tab.
 */
export function countTabEntries(tabs: Tab[]): number {
  let n = 0;
  for (const t of tabs) n += t.kind === "pane" ? leaves(t.paneTree).length : 1;
  return n;
}
