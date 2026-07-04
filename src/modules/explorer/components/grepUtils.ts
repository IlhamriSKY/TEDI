export type GrepHit = {
  path: string;
  rel: string;
  line: number;
  text: string;
};

export type GrepResponse = {
  hits: GrepHit[];
  truncated: boolean;
  files_scanned: number;
};

export type GrepReplaceResponse = {
  files_changed: number;
  total_replacements: number;
  edits: { path: string; rel: string; replacements: number }[];
  truncated: boolean;
};

export const HIGHLIGHT_CLASS = "bg-icon-working/30 text-foreground rounded-[2px] px-[1px]";

export const MAX_LINE_CHARS = 240;

export { escapeRegex } from "@/lib/utils";

/**
 * Tries to compile the user's regex client-side so we can show a "bad regex"
 * hint without round-tripping to Rust. JS regex isn't identical to Rust's
 * `regex` crate (no lookbehind in older browsers, slightly different
 * character-class semantics) but the common syntax overlaps - good enough
 * for early validation.
 */
export function tryCompileRegex(pattern: string): string | null {
  try {
    new RegExp(pattern);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "invalid regex";
  }
}

export type Row =
  | { kind: "file"; rel: string; path: string; count: number }
  | { kind: "hit"; hit: GrepHit; hitIdx: number };
