/**
 * Permission gate for the extension host API.
 *
 * Permissions are kebab-case strings declared in the manifest and approved
 * at install time. Examples:
 *   `settings:read`, `settings:write`
 *   `secrets:read`, `secrets:write`
 *   `invoke:my_command_*` (glob), `invoke:fs_read_file` (exact)
 *   `events:emit`, `events:listen`
 *   `ui:toast`, `ui:openTab`
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

const HARD_DENY_INVOKE: ReadonlySet<string> = new Set([
  // Block keychain dump even with `invoke:*`. Use `tedi.secrets.get(name)`.
  "secrets_get_all",
]);

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

/** Risk label for the install dialog. Lower is safer. */
export function permissionRiskTier(p: string): "low" | "medium" | "high" {
  if (p === "*") return "high";
  if (p.startsWith("invoke:")) {
    // FS/shell/secrets invokes are high; others medium.
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
  // `shell:transform` lets an extension rewrite every AI shell command;
  // mark high so the install dialog flags it.
  if (p === "shell:transform") return "high";
  return "medium";
}
