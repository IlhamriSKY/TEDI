import { openUrl } from "@tauri-apps/plugin-opener";
import type { ReactNode } from "react";

/** Renders CHANGELOG-derived release notes as tidy, scrollable content. The
 *  notes use a constrained markdown subset (### headings, - bullets, fenced
 *  code, **bold**, `inline code`, [text](url), --- dividers), so a small
 *  purpose-built renderer beats pulling a full markdown engine into both the
 *  main and settings webviews.
 *  Note: handles only the subset the release-notes generator emits; if the
 *  changelog grows richer markdown (images, nested lists, tables), swap this
 *  for the shared Streamdown renderer. */

// Inline: **bold**, `code`, and [text](url). http(s) links open externally;
// relative file references (e.g. [EditorPane.tsx](src/...)) render as plain
// text since they cannot be opened in-app.
function Inline({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = i++;
    if (m[1] !== undefined) {
      out.push(
        <strong key={key} className="text-foreground font-semibold">
          {m[1]}
        </strong>,
      );
    } else if (m[2] !== undefined) {
      out.push(
        <code key={key} className="bg-muted rounded px-1 py-0.5 font-mono text-[0.9em]">
          {m[2]}
        </code>,
      );
    } else if (/^https?:\/\//.test(m[4])) {
      const url = m[4];
      out.push(
        <button
          key={key}
          type="button"
          onClick={() => void openUrl(url)}
          className="text-foreground cursor-pointer underline underline-offset-2 hover:opacity-80"
        >
          {m[3]}
        </button>,
      );
    } else {
      out.push(
        <span key={key} className="text-foreground/80">
          {m[3]}
        </span>,
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

export function ReleaseNotes({ notes }: { notes: string }) {
  const lines = notes.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  let code: string[] | null = null;

  const flushBullets = () => {
    if (!bullets.length) return;
    const items = bullets;
    bullets = [];
    blocks.push(
      <ul key={`ul-${blocks.length}`} className="ml-4 list-disc space-y-1.5">
        {items.map((b, i) => (
          <li key={i}>
            <Inline text={b} />
          </li>
        ))}
      </ul>,
    );
  };

  const pushCode = (body: string, key: string) =>
    blocks.push(
      <pre
        key={key}
        className="border-border/50 bg-muted/60 overflow-x-auto rounded-md border p-2 font-mono text-[11px]"
      >
        {body}
      </pre>,
    );

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (/^```/.test(line.trim())) {
      if (code === null) {
        flushBullets();
        code = [];
      } else {
        pushCode(code.join("\n"), `code-${blocks.length}`);
        code = null;
      }
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }
    const t = line.trim();
    if (/^###\s+/.test(t)) {
      flushBullets();
      blocks.push(
        <div
          key={`h-${idx}`}
          className="text-muted-foreground mt-3 mb-0.5 text-[10px] font-semibold tracking-wide uppercase first:mt-0"
        >
          {t.replace(/^###\s+/, "")}
        </div>,
      );
    } else if (/^-\s+/.test(t)) {
      bullets.push(t.replace(/^-\s+/, ""));
    } else if (/^-{3,}$/.test(t)) {
      flushBullets();
      blocks.push(<hr key={`hr-${idx}`} className="border-border/50 my-3" />);
    } else if (t === "") {
      flushBullets();
    } else {
      flushBullets();
      blocks.push(
        <p key={`p-${idx}`}>
          <Inline text={t} />
        </p>,
      );
    }
  }
  flushBullets();
  if (code !== null && code.length) pushCode(code.join("\n"), "code-end");

  return <div className="space-y-1.5">{blocks}</div>;
}
