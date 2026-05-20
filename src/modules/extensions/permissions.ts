/**
 * Permission gate for the extension host API.
 *
 * Permissions are simple kebab-case strings declared in the manifest and
 * approved by the user at install time. Format examples:
 *
 *   - `settings:read`               — read any preference
 *   - `settings:write`              — write any preference (own or built-in)
 *   - `secrets:read`                — read OS keychain entries
 *   - `secrets:write`               — write OS keychain entries
 *   - `invoke:my_command_*`         — call a Rust command matching the glob
 *   - `invoke:fs_read_file`         — call one exact Rust command
 *   - `events:emit`                 — emit (namespaced) Tauri events
 *   - `events:listen`               — listen on (namespaced) Tauri events
 *   - `ui:toast`                    — show toast notifications
 *   - `ui:openTab`                  — open new tabs in the main window
 *   - `panels:register`             — register sidebar/statusbar panels
 *
 * Anything not declared is denied at call time. The host throws a tagged
 * error so the extension can react gracefully instead of silently
 * misbehaving.
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

const HARD_DENY_INVOKE: ReadonlySet<string> = new Set([
  // Even with `invoke:*`, never let extensions read the entire keychain.
  // Force them through the per-key `tedi.secrets.get(name)` path which
  // makes the intended namespace obvious in the manifest review.
  "secrets_get_all",
]);

export function checkPermission(declared: readonly string[], required: string): boolean {
  // Wildcard - manifests can declare `*` for power-user installs, but we
  // still show an extra-loud warning in the install dialog.
  if (declared.includes("*")) return true;
  for (const p of declared) {
    if (p === required) return true;
    if (p.endsWith(":*")) {
      const prefix = p.slice(0, -1); // keep colon
      if (required.startsWith(prefix)) return true;
    }
    // Glob form `invoke:foo_*` matches `invoke:foo_bar`.
    if (p.includes("*")) {
      const re = new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      if (re.test(required)) return true;
    }
  }
  return false;
}

export function isInvokeAllowed(
  declared: readonly string[],
  command: string,
): boolean {
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

/** Human-readable risk label for the install dialog. Lower is safer. */
export function permissionRiskTier(p: string): "low" | "medium" | "high" {
  if (p === "*") return "high";
  if (p.startsWith("invoke:")) {
    // Plain-data invokes are low; anything that touches FS/shell/secrets is high.
    if (p.startsWith("invoke:fs_") || p.startsWith("invoke:shell_") || p.startsWith("invoke:secrets_"))
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
  return "medium";
}
