import { useMemo } from "react";
import { escapeRegex, HIGHLIGHT_CLASS, MAX_LINE_CHARS } from "./grepUtils";

export function HighlightLine({
  text,
  needle,
  useRegex,
  caseInsensitive,
}: {
  text: string;
  needle: string;
  useRegex: boolean;
  caseInsensitive: boolean;
}) {
  const trimmed = text.length > MAX_LINE_CHARS ? text.slice(0, MAX_LINE_CHARS) + "…" : text;
  const re = useMemo(() => {
    if (!needle) return null;
    try {
      const src = useRegex ? needle : escapeRegex(needle);
      return new RegExp(src, caseInsensitive ? "gi" : "g");
    } catch {
      return null;
    }
  }, [needle, useRegex, caseInsensitive]);
  if (!needle || !re) return <>{trimmed}</>;
  const out: React.ReactNode[] = [];
  let lastIdx = 0;
  let k = 0;
  for (const m of trimmed.matchAll(re)) {
    const start = m.index ?? 0;
    if (start > lastIdx) out.push(trimmed.slice(lastIdx, start));
    out.push(
      <span key={k++} className={HIGHLIGHT_CLASS}>
        {m[0]}
      </span>,
    );
    lastIdx = start + m[0].length;
    // Zero-width match guard: advance one char so we don't loop forever.
    if (m[0].length === 0) lastIdx = start + 1;
  }
  if (lastIdx < trimmed.length) out.push(trimmed.slice(lastIdx));
  return <>{out}</>;
}
