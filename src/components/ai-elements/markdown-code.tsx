"use client";

import {
  createContext,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import { tableDataToMarkdown } from "streamdown";
import { Check, Copy, Maximize2, Search, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { floatPane } from "@/modules/panes/floatHost";

import { ChatCodeBlock } from "./chat-code";
import { MermaidDiagram } from "./mermaid-diagram";

/**
 * Streamdown `components.code` override. Handles both inline (`code`) and
 * fenced blocks (className "language-X"). `mermaid` blocks render as a
 * diagram; other fenced blocks delegate to the Lezer-based syntax
 * highlighter; inline stays a plain pill.
 */
export function MarkdownCode({
  className,
  children,
  ...rest
}: {
  className?: string;
  children?: ReactNode;
}) {
  const match = className?.match(/language-(\w+)/);
  if (!match) {
    return (
      <code
        className="bg-muted/70 text-foreground rounded px-1.5 py-0.5 font-mono text-[11px]"
        {...rest}
      >
        {children}
      </code>
    );
  }

  const lang = match[1] ?? null;
  const code = String(children ?? "").replace(/\n$/, "");
  if (lang?.toLowerCase() === "mermaid") {
    return <MermaidDiagram code={code} />;
  }
  return <ChatCodeBlock code={code} lang={lang} />;
}

/** True inside a floating table window (see `FloatApp`) - hides the redundant
 *  "open in pane" control since the table is already popped out. */
const InFloatCtx = createContext(false);
export const FloatTableProvider = InFloatCtx.Provider;

// Table floats aren't backed by a pane leaf; a distinct negative id space keeps
// their window label / float events from ever colliding with real (positive) leaf
// ids. Ref-held per table so re-clicking focuses the existing window.
let tableFloatSeq = 0;
const nextTableFloatId = () => -1000 - ++tableFloatSeq;

/** Serialize a rendered `<table>` to markdown. `visibleOnly` skips rows the search
 *  filter hid (used by copy); float passes false to capture the whole table. */
function tableToMarkdown(el: HTMLTableElement, visibleOnly: boolean): string {
  const headers = Array.from(el.querySelectorAll("thead th")).map(
    (th) => th.textContent?.trim() ?? "",
  );
  // Single pass over the body rows: skip search-hidden rows when visibleOnly,
  // then collect each visible row's cell text.
  const rows: string[][] = [];
  for (const tr of el.querySelectorAll<HTMLTableRowElement>("tbody tr")) {
    if (visibleOnly && tr.style.display === "none") continue;
    rows.push(Array.from(tr.querySelectorAll("td")).map((td) => td.textContent?.trim() ?? ""));
  }
  return tableDataToMarkdown({ headers, rows });
}

/** Card chrome + header bar shared by the inline and popped-out tables, so both
 *  read as one component: a slim control bar (search + copy + expand/close on the
 *  right), a divider, then the grid. No label - many AI tables have no meaningful
 *  header. Matches the code-block `BlockChrome`. */
const CARD_CLS = "not-prose border-border/60 overflow-hidden rounded-lg border";
const HEADER_BAR_CLS =
  "border-border/50 bg-muted/30 flex shrink-0 items-center gap-2 border-b px-2 py-1";

/**
 * Cell-level restyle applied to the scroll container that holds the table.
 * Streamdown still renders the cells (stable `data-streamdown` hooks); this
 * makes them compact and tidy - a sticky solid header, dense padding, subtle
 * column/row separators - instead of the default airy `px-4 py-2`. The outer
 * border + rounded card and the header bar are supplied by the wrapper, so this
 * carries no border of its own. `!` beats Streamdown's own cell utilities.
 */
const TABLE_CLS = cn(
  "[&_table]:!my-0 [&_table]:w-full [&_table]:border-collapse [&_table]:text-left",
  // Sticky, opaque header so rows don't bleed through when the grid scrolls.
  "[&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_[data-streamdown=table-header]]:!bg-muted",
  // Compact cells.
  "[&_[data-streamdown=table-header-cell]]:!px-2.5 [&_[data-streamdown=table-header-cell]]:!py-1.5 [&_[data-streamdown=table-header-cell]]:!text-[11px]",
  "[&_[data-streamdown=table-cell]]:!px-2.5 [&_[data-streamdown=table-cell]]:!py-1.5 [&_[data-streamdown=table-cell]]:!align-top [&_[data-streamdown=table-cell]]:!text-[11px]",
  // Subtle vertical column separators (rows already get divide-y from Streamdown).
  "[&_th:not(:last-child)]:border-r [&_th]:border-border/40",
  "[&_td:not(:last-child)]:border-r [&_td]:border-border/40",
  // Zebra + hover for scannability. Zebra is driven by a `data-zebra` marker the
  // filter sets on visible rows (see useTableFilter), not :nth-child.
  "[&_tbody_tr[data-zebra]]:bg-muted/20 [&_tbody_tr:hover]:bg-muted/40",
);

/** Copy-as-markdown wired to a table ref, with a 1.5s "copied" pulse. Shared
 *  by the inline control and the popped-out header. Reads the VISIBLE rows only
 *  (skips the ones `useTableFilter` hid) so copy honors an active search - with
 *  no filter, `display` is never "none" so this equals the whole table. */
function useCopyTable(ref: RefObject<HTMLTableElement | null>) {
  const [copied, setCopied] = useState(false);
  const tRef = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(tRef.current), []);
  const onCopy = useCallback(async () => {
    const el = ref.current;
    if (!el || !navigator?.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(tableToMarkdown(el, true));
      setCopied(true);
      tRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* swallow */
    }
  }, [ref]);
  return { copied, onCopy };
}

/** Filter `tbody` rows by substring, in place via `display:none`. Re-runs on
 *  `children` too so streamed-in rows stay filtered; the setState guard keeps
 *  the per-render re-run from looping.
 *  Note: DOM-hide filter, O(rows) per render - fine for chat-sized tables. */
function useTableFilter(ref: RefObject<HTMLTableElement | null>, children: ReactNode) {
  const [query, setQuery] = useState("");
  const [counts, setCounts] = useState({ shown: 0, total: 0 });
  useEffect(() => {
    const table = ref.current;
    if (!table) return;
    const rows = Array.from(table.querySelectorAll<HTMLTableRowElement>("tbody tr"));
    const q = query.trim().toLowerCase();
    let shown = 0;
    for (const r of rows) {
      const match = !q || (r.textContent ?? "").toLowerCase().includes(q);
      r.style.display = match ? "" : "none";
      if (match) {
        // Zebra off the VISIBLE index, not CSS :nth-child (which counts the
        // display:none rows and would mis-stripe once a filter hides some).
        if (shown % 2) r.dataset.zebra = "";
        else delete r.dataset.zebra;
        shown++;
      }
    }
    setCounts((prev) =>
      prev.shown === shown && prev.total === rows.length ? prev : { shown, total: rows.length },
    );
  }, [query, children, ref]);
  return { query, setQuery, shown: counts.shown, total: counts.total };
}

function TableGrid({
  tableRef,
  tableProps,
  className,
  children,
}: {
  tableRef: RefObject<HTMLTableElement | null>;
  tableProps: ComponentProps<"table">;
  className?: string;
  children: ReactNode;
}) {
  // Hide an all-empty header row - common in AI key/value tables written as
  // `| | |`, which Streamdown renders as a blank sticky strip. Re-runs on
  // `children` so a header that streams in real text un-hides itself.
  useEffect(() => {
    const thead = tableRef.current?.querySelector("thead");
    if (!thead) return;
    const ths = Array.from(thead.querySelectorAll("th"));
    (thead as HTMLElement).hidden = ths.length > 0 && ths.every((th) => !th.textContent?.trim());
  }, [tableRef, children]);
  return (
    <div className={cn("bg-background overflow-auto", TABLE_CLS, className)}>
      <table ref={tableRef} {...tableProps}>
        {children}
      </table>
    </div>
  );
}

function ToolBtn({
  icon: Icon,
  label,
  onClick,
  active,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          onClick={onClick}
          aria-label={label}
          // Toggle state for AT (only the search button passes `active`); the
          // ghost variant already styles `aria-expanded:` so the active tint
          // comes for free, no manual class needed.
          aria-expanded={active}
          className="text-muted-foreground hover:text-foreground size-6"
        >
          <Icon size={12} strokeWidth={1.75} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

function TableSearchField({
  value,
  onChange,
  shown,
  total,
  className,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  shown: number;
  total: number;
  className?: string;
  autoFocus?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);
  return (
    <div className={cn("relative flex min-w-0 items-center", className)}>
      <Search
        size={12}
        strokeWidth={1.75}
        className="text-muted-foreground pointer-events-none absolute left-2"
      />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Search table"
        placeholder="Search table…"
        className="bg-input/50 border-border/60 focus-visible:border-ring h-7 w-full rounded-md border py-1 pr-14 pl-7 text-[11px] outline-none"
      />
      {value.trim() ? (
        <span className="text-muted-foreground pointer-events-none absolute right-2 text-[10px] tabular-nums">
          {shown}/{total}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Streamdown `components.table` override. Streamdown's built-in table controls
 * are disabled at the `<Streamdown controls={{ table: false }}>` call site;
 * this supplies the app-consistent chrome instead: a slim control bar with
 * search (filters rows in place), copy-as-markdown, and open-in-pane (pops the
 * table out into its own always-on-top float window, like a terminal pane).
 * Shared by the AI chat and the editor's markdown preview, so both surfaces look
 * and behave identically; inside a float window the open-in-pane control hides.
 */
export function MarkdownTable({ children, ...props }: ComponentProps<"table">) {
  const ref = useRef<HTMLTableElement>(null);
  const { query, setQuery, shown, total } = useTableFilter(ref, children);
  const { copied, onCopy } = useCopyTable(ref);
  const [searchOpen, setSearchOpen] = useState(false);
  const inFloat = use(InFloatCtx);
  const floatIdRef = useRef<number | null>(null);

  const toggleSearch = () => {
    setSearchOpen((v) => {
      if (v) setQuery("");
      return !v;
    });
  };

  const onFloat = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (floatIdRef.current === null) floatIdRef.current = nextTableFloatId();
    void floatPane(
      {
        leafId: floatIdRef.current,
        kind: "table",
        title: "Table",
        markdown: tableToMarkdown(el, false),
      },
      { w: 760, h: 560 },
    );
  }, []);

  const toolbar = (
    <>
      <ToolBtn icon={Search} label="Search table" onClick={toggleSearch} active={searchOpen} />
      <ToolBtn
        icon={copied ? Check : Copy}
        label={copied ? "Copied" : "Copy table"}
        onClick={onCopy}
      />
      {!inFloat && <ToolBtn icon={Maximize2} label="Open in pane" onClick={onFloat} />}
    </>
  );

  return (
    // Float window scrolls the whole card (natural height, no outer margin);
    // inline keeps vertical rhythm.
    <div className={cn(CARD_CLS, inFloat ? "" : "my-3")}>
      {/* Slim control bar: the controls pinned top-right (no label). Search
          expands into the bar and shrinks the field on narrow widths. */}
      <div className={HEADER_BAR_CLS}>
        {searchOpen ? (
          <TableSearchField
            value={query}
            onChange={setQuery}
            shown={shown}
            total={total}
            className="flex-1"
            autoFocus
          />
        ) : null}
        <div className="ms-auto flex items-center gap-0.5">{toolbar}</div>
      </div>

      <TableGrid tableRef={ref} tableProps={props}>
        {children}
      </TableGrid>
    </div>
  );
}

/**
 * Shared Streamdown `components` map wiring fenced blocks through the
 * Lezer-highlighted renderer and tables through the host-tooltip toolbar.
 * Used by both the AI chat (`MessageResponse`) and the editor's markdown file
 * preview so code blocks and tables look identical in either surface. Module-
 * level constant so Streamdown sees a stable reference and doesn't re-render on
 * every parent render.
 */
export const markdownComponents = { code: MarkdownCode, table: MarkdownTable };
