/**
 * Public entry point for the editor's format-on-save / format-document
 * pipeline. Resolves the configured formatter for a file path and runs it
 * against the buffer, returning the formatted text.
 *
 * Resolution order:
 *   1. `languageFromPath(path)` derives a language id.
 *   2. `formatters[language]` from preferences picks an explicit config.
 *   3. Otherwise fall back to the shipped default for that language, so
 *      format-on-save covers every supported language out of the box:
 *      built-in Prettier for the web languages, the external preset
 *      (rustfmt, gofmt, ruff, …) for the rest.
 *   4. `type` dispatches to prettier (builtin) or the external pipeline.
 *
 * Throws a typed error when no formatter is configured or the run fails;
 * callers display the error via a toast and skip the save formatting.
 */

import { usePreferencesStore } from "@/modules/settings/preferences";
import type { FormatterConfig } from "@/modules/settings/store";
import { formatWithExternal } from "./external";
import { formatWithPrettier, prettierSupports } from "./prettier";
import { languageFromPath, BUILTIN_LANGUAGES } from "./lang";
import { buildPresetConfig } from "./presets";

export { languageFromPath, BUILTIN_LANGUAGES, ALL_LANGUAGES, LANGUAGE_LABELS } from "./lang";
export { prettierSupports } from "./prettier";
export { EXTERNAL_PRESETS, buildPresetConfig, hasPreset } from "./presets";
export { FormatterUnavailableError } from "./external";

export class NoFormatterError extends Error {
  constructor(public language: string | null) {
    super(
      language
        ? `No formatter configured for "${language}". Set one in Settings → Code Editor → Formatters.`
        : "No formatter: file extension not recognised.",
    );
    this.name = "NoFormatterError";
  }
}

/**
 * The formatter to use for a language when the user has NOT explicitly
 * configured one: built-in Prettier for the web languages it can parse,
 * otherwise the external preset (rustfmt, gofmt, ruff, …). null when neither
 * exists. This is what makes format-on-save work for every language without
 * pre-populating the whole preset table into the settings store.
 */
function defaultFormatterFor(lang: string): FormatterConfig | null {
  if (BUILTIN_LANGUAGES.has(lang)) return { type: "builtin" };
  return buildPresetConfig(lang);
}

export function shouldFormatOnSave(path: string): boolean {
  const state = usePreferencesStore.getState();
  const lang = languageFromPath(path);
  if (!lang) return false;
  const explicit = state.formatters[lang];
  const cfg = explicit ?? defaultFormatterFor(lang);
  if (!cfg || cfg.type === "none") return false;
  // A per-language override (only settable on an explicit config) beats the global.
  if (explicit && typeof explicit.formatOnSave === "boolean") return explicit.formatOnSave;
  return state.formatOnSave;
}

export async function formatDocument(args: { path: string; content: string }): Promise<string> {
  const lang = languageFromPath(args.path);
  if (!lang) throw new NoFormatterError(null);

  const explicit = usePreferencesStore.getState().formatters[lang];
  const cfg = explicit ?? defaultFormatterFor(lang);
  if (!cfg || cfg.type === "none") throw new NoFormatterError(lang);

  let formatted: string;
  if (cfg.type === "builtin") {
    if (!prettierSupports(lang)) {
      throw new Error(`Built-in formatter does not support "${lang}". Use an external formatter.`);
    }
    formatted = await formatWithPrettier({
      language: lang,
      content: args.content,
      filepath: args.path,
    });
  } else {
    // external — an explicit "external" row with no command is a
    // misconfiguration; treat it as no-formatter so auto-save stays silent.
    if (!cfg.command || cfg.command.trim().length === 0) {
      throw new NoFormatterError(lang);
    }
    formatted = await formatWithExternal({
      command: cfg.command,
      args: cfg.args ?? [],
      content: args.content,
      filepath: args.path,
    });
  }

  // Refuse an empty result on a non-empty buffer: a formatter that exits 0 but
  // writes nothing (e.g. `black` invoked without `-`, or a preset that ignores
  // stdin) would otherwise blank the file and the save would persist "". The
  // throw makes the save flow fall through to writing the original content.
  if (args.content.trim() !== "" && formatted.trim() === "") {
    throw new Error("Formatter returned empty output, refusing to blank the file.");
  }
  return formatted;
}
