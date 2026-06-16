/**
 * Permission gate for the extension host API.
 *
 * Permissions are kebab-case strings declared in the manifest and approved
 * at install time. Examples:
 *   `settings:read`, `settings:write`
 *   `secrets:read`, `secrets:write`
 *   `invoke:my_command_*` (glob), `invoke:fs_read_file` (exact)
 *   `events:emit`, `events:listen`
 *   `ui:toast`, `tabs:open`
 *   `panels:register`
 *
 * Anything undeclared is denied; the host throws `PermissionDeniedError`.
 */

export class PermissionDeniedError extends Error {
  constructor(
    public readonly extensionId: string,
    public readonly permission: string,
  ) {
    super(`extension "${extensionId}" lacks permission "${permission}"`);
    this.name = "PermissionDeniedError";
  }
}

// Keychain commands the gated `ctx.invoke()` path refuses outright, even with
// `invoke:*`. Extensions must use the `ctx.secrets.*` facade, which namespaces
// every key under `tedi-ext:<id>` so an extension can neither enumerate the
// keychain nor read the main app's provider keys (stored under service
// `tedi`). `secrets_get`/`set`/`delete` are denied alongside `secrets_get_all`
// because a raw `secrets_get({ service: "tedi", account })` would otherwise
// sidestep that namespace one key at a time.
//
// NOTE: this gate covers the host-provided `ctx.invoke` only. The v1 trust
// model (see module doc) is install-time permission review: extension JS runs
// in the main webview and can `import { invoke } from "@tauri-apps/api/core"`
// directly, bypassing this set. Hardening that fully requires sandboxing
// extension code (iframe/worker) - tracked separately. This list still raises
// the bar for well-behaved extensions and documents intent.
const HARD_DENY_INVOKE: ReadonlySet<string> = new Set([
  "secrets_get_all",
  "secrets_get",
  "secrets_set",
  "secrets_delete",
]);

const GLOB_ESCAPE_RE = /[.+?^${}()|[\]\\]/g;
const GLOB_RE_CACHE = new Map<string, RegExp>();
function globToRegExp(pattern: string): RegExp {
  let re = GLOB_RE_CACHE.get(pattern);
  if (!re) {
    re = new RegExp("^" + pattern.replace(GLOB_ESCAPE_RE, "\\$&").replace(/\*/g, ".*") + "$");
    GLOB_RE_CACHE.set(pattern, re);
  }
  return re;
}

export function checkPermission(declared: readonly string[], required: string): boolean {
  // Wildcard. Manifests can declare `*`; the install dialog warns loudly.
  if (declared.includes("*")) return true;
  for (const p of declared) {
    if (p === required) return true;
    if (p.endsWith(":*")) {
      const prefix = p.slice(0, -1); // keep colon
      if (required.startsWith(prefix)) return true;
    }
    // `invoke:foo_*` matches `invoke:foo_bar`.
    if (p.includes("*")) {
      if (globToRegExp(p).test(required)) return true;
    }
  }
  return false;
}

export function isInvokeAllowed(declared: readonly string[], command: string): boolean {
  if (HARD_DENY_INVOKE.has(command)) return false;
  return checkPermission(declared, `invoke:${command}`);
}

export function requirePermission(
  extensionId: string,
  declared: readonly string[],
  required: string,
): void {
  if (!checkPermission(declared, required)) {
    throw new PermissionDeniedError(extensionId, required);
  }
}

/** Risk label for the install dialog. Lower is safer. */
export function permissionRiskTier(p: string): "low" | "medium" | "high" {
  if (p === "*") return "high";
  if (p.startsWith("invoke:")) {
    const cmd = p.slice("invoke:".length);
    // Any glob is HIGH. `invoke:*` grants near-total access; a family glob like
    // `invoke:git_*` / `invoke:pty_*` / `invoke:s*` still spans a whole group of
    // powerful (often destructive) commands. Globs over the app's command
    // surface are inherently broad, so warn red and nudge authors toward exact,
    // least-privilege `invoke:<command>` grants.
    if (cmd.includes("*")) return "high";
    // Code-execution / remote-shell / arbitrary-binary families are HIGH even as
    // an exact single command: fs_ (disk), shell_ (process), secrets_ (keychain),
    // pty_ (spawns a real shell = local code execution), ssh_ (remote shell +
    // SFTP write/delete), and fmt_run_external (runs an arbitrary external
    // binary, deliberately bypassing the shell).
    if (
      cmd.startsWith("fs_") ||
      cmd.startsWith("shell_") ||
      cmd.startsWith("secrets_") ||
      cmd.startsWith("pty_") ||
      cmd.startsWith("ssh_") ||
      cmd === "fmt_run_external"
    )
      return "high";
    return "medium";
  }
  if (p.startsWith("secrets:")) return "high";
  if (p.startsWith("settings:write")) return "medium";
  if (p.startsWith("settings:")) return "low";
  if (p.startsWith("events:")) return "low";
  if (p.startsWith("ui:")) return "low";
  if (p.startsWith("panels:")) return "low";
  if (p.startsWith("statusbar:")) return "low";
  if (p.startsWith("headerbar:")) return "low";
  if (p.startsWith("sidebar:")) return "low";
  if (p === "tabs:open") return "low";
  // Active-editor buffer access. Read returns the live (possibly dirty)
  // text; write replaces it via a CodeMirror transaction. Medium-risk
  // because an extension could quietly mangle code the user is editing.
  if (p === "editor:read" || p === "editor:write") return "medium";
  // `shell:transform` lets an extension rewrite every AI shell command;
  // mark high so the install dialog flags it.
  if (p === "shell:transform") return "high";
  return "medium";
}
