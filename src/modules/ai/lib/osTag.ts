import { arch, platform, version as osVersion } from "@tauri-apps/plugin-os";

/** Host OS identity, captured once at module load. Module-scoped so the
 *  system-prompt prefix stays byte-identical across turns for prompt caching. */
export const OS_TAG: string | null = (() => {
  try {
    const plat = platform();
    const friendly =
      plat === "macos"
        ? "macOS"
        : plat === "windows"
          ? "Windows"
          : plat === "linux"
            ? "Linux"
            : plat.charAt(0).toUpperCase() + plat.slice(1);
    const v = osVersion();
    return `${friendly}${v ? ` ${v}` : ""} (${arch()})`;
  } catch {
    return null;
  }
})();

/** Default shell name for the host OS. Best-effort hint; the user may have
 *  reconfigured. pwsh on Windows, POSIX elsewhere. */
export const DEFAULT_SHELL: string | null = (() => {
  try {
    const plat = platform();
    if (plat === "windows") return "pwsh";
    if (plat === "macos") return "zsh";
    if (plat === "linux") return "bash";
    return null;
  } catch {
    return null;
  }
})();

/** One-line host tag for the system-prompt prefix. Empty means skip. */
export const HOST_PROMPT_LINE: string =
  OS_TAG && DEFAULT_SHELL
    ? `Host: ${OS_TAG} · shell: ${DEFAULT_SHELL}`
    : OS_TAG
      ? `Host: ${OS_TAG}`
      : "";
