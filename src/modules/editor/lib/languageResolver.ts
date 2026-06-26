/**
 * Path → CodeMirror language resolution.
 *
 * The full language catalog (loaders, detection rules, icons, labels) lives in
 * {@link ./languages}. This module is the thin "resolve by filename" entry the
 * editor and both diff panes consume; manual overrides go through
 * `resolveLanguageById` from the registry instead.
 */
import type { Extension } from "@codemirror/state";
import { detectLanguageId, resolveLanguageById } from "./languages";

/** Resolve the language for a path. Returns `null` for unknown file types. */
export async function resolveLanguage(filename: string): Promise<Extension | null> {
  const id = detectLanguageId(filename);
  if (!id) return null;
  return resolveLanguageById(id);
}
