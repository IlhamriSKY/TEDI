/**
 * Public entry point for the editor's format-on-save / format-document
 * pipeline. Resolves the configured formatter for a file path and runs it
 * against the buffer, returning the formatted text.
 *
 * Resolution order:
 *   1. `languageFromPath(path)` derives a language id.
 *   2. `formatters[language]` from preferences picks a config.
 *   3. `type` dispatches to prettier (builtin) or the external pipeline.
 *
 * Throws a typed error when no formatter is configured or the run fails;
 * callers display the error via a toast and skip the save formatting.
 */

import { usePreferencesStore } from "@/modules/settings/preferences";
import { formatWithExternal } from "./external";
import { formatWithPrettier, prettierSupports } from "./prettier";
import { languageFromPath } from "./lang";

export { languageFromPath, BUILTIN_LANGUAGES, ALL_LANGUAGES, LANGUAGE_LABELS } from "./lang";
export { prettierSupports } from "./prettier";
export { EXTERNAL_PRESETS, buildPresetConfig, hasPreset } from "./presets";

export class NoFormatterError extends Error {
  constructor(public language: string | null) {
    super(
      language
        ? `No formatter configured for "${language}". Set one in Settings → Code Editor → Formatters.`
        : "No formatter — file extension not recognised.",
    );
    this.name = "NoFormatterError";
  }
}

export function shouldFormatOnSave(path: string): boolean {
  const state = usePreferencesStore.getState();
  const lang = languageFromPath(path);
  if (!lang) return false;
  const cfg = state.formatters[lang];
  if (!cfg || cfg.type === "none") return false;
  // Per-language override beats the global.
  if (typeof cfg.formatOnSave === "boolean") return cfg.formatOnSave;
  return state.formatOnSave;
}

export async function formatDocument(args: { path: string; content: string }): Promise<string> {
  const lang = languageFromPath(args.path);
  if (!lang) throw new NoFormatterError(null);

  const cfg = usePreferencesStore.getState().formatters[lang];
  if (!cfg || cfg.type === "none") throw new NoFormatterError(lang);

  if (cfg.type === "builtin") {
    if (!prettierSupports(lang)) {
      throw new Error(`Built-in formatter does not support "${lang}". Use an external formatter.`);
    }
    return formatWithPrettier({
      language: lang,
      content: args.content,
      filepath: args.path,
    });
  }

  // external
  if (!cfg.command || cfg.command.trim().length === 0) {
    throw new Error(`External formatter for "${lang}" is missing a command.`);
  }
  return formatWithExternal({
    command: cfg.command,
    args: cfg.args ?? [],
    content: args.content,
    filepath: args.path,
  });
}
