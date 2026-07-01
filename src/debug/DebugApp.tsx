import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { cn } from "@/lib/utils";
import { toast, Toaster } from "@/components/ui/toast";
import { IS_MAC, USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { useDebugStore, type DebugCapture } from "@/modules/ai/store/debugStore";
import { startDebugClient, clearDebugRemote } from "@/modules/ai/store/debugBridge";

const dl = (f: string, d: unknown) => {
  const u = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)]));
  const a = document.createElement("a");
  a.href = u;
  a.download = f;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(u);
  toast(`Downloaded ${f}`, { variant: "success" });
};
const msgC = (c: DebugCapture) => (Array.isArray(c.messages) ? c.messages.length : 0);
const toolC = (c: DebugCapture) => c.tools?.length ?? 0;
const trunc = (s: string, n = 8) => (s.length > n ? `${s.slice(0, n)}…` : s);
const stamp = (t: number) => new Date(t).toISOString().replace(/[:.]/g, "-");

type Filter = { key: string; label: string; count: number; fn: (c: DebugCapture) => boolean };

function buildFilters(caps: DebugCapture[]): Filter[] {
  const subs = [
    ...new Set(
      caps.filter((c) => c.kind === "subagent" && c.subagentType).map((c) => c.subagentType!),
    ),
  ];
  return [
    { key: "all", label: "All", count: caps.length, fn: () => true },
    {
      key: "main",
      label: "Main Agent",
      count: caps.filter((c) => c.kind === "main").length,
      fn: (c) => c.kind === "main",
    },
    ...subs.map((t) => ({
      key: `sub:${t}`,
      label: t[0].toUpperCase() + t.slice(1),
      count: caps.filter((c) => c.kind === "subagent" && c.subagentType === t).length,
      fn: (c: DebugCapture) => c.kind === "subagent" && c.subagentType === t,
    })),
  ];
}

function groupSessions(
  caps: DebugCapture[],
): { sid: string | null; label: string; m: number; s: number }[] {
  const map = new Map<string, DebugCapture[]>();
  for (const c of caps) {
    const k = c.sessionId ?? "_";
    (map.get(k) ?? map.set(k, []).get(k)!).push(c);
  }
  return [...map.entries()].map(([k, v]) => ({
    sid: k === "_" ? null : k,
    label: k === "_" ? "(none)" : trunc(k),
    m: v.filter((c) => c.kind === "main").length,
    s: v.length - v.filter((c) => c.kind === "main").length,
  }));
}

function Chip({
  active,
  count,
  children,
  onClick,
}: {
  active: boolean;
  count: number;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md border px-2 py-1 text-[10.5px] transition-colors",
        active
          ? "border-accent bg-accent font-medium"
          : "border-border/50 text-muted-foreground hover:bg-accent/40",
      )}
    >
      <span className="mr-1">{children}</span>
      <span className="opacity-60">{count}</span>
    </button>
  );
}

function Row({ c, active, onClick }: { c: DebugCapture; active: boolean; onClick: () => void }) {
  const d = new Date(c.at);
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full flex-col gap-1 rounded-md border px-2.5 py-2 text-left transition-colors",
        active ? "border-accent bg-accent" : "border-border/50 hover:bg-accent/40",
      )}
    >
      <div className="flex items-center gap-1.5">
        <Badge
          variant={c.kind === "main" ? "default" : "secondary"}
          className="h-4 px-1 text-[9px] leading-none"
        >
          {c.kind === "main" ? "MAIN" : (c.subagentType ?? "SUB")}
        </Badge>
        <span className="truncate text-[11.5px] font-medium">{c.model.id}</span>
      </div>
      <div className="text-muted-foreground flex items-center gap-2 font-mono text-[10px]">
        <span>
          {d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}{" "}
          {d.toLocaleTimeString()}
        </span>
        <span className="text-muted-foreground/50">·</span>
        <span>{msgC(c)} msg</span>
        <span className="text-muted-foreground/50">·</span>
        <span>{toolC(c)} tools</span>
      </div>
    </button>
  );
}

const TABS = ["summary", "system", "messages", "raw"] as const;
const InfoCard = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="border-border/50 bg-muted/20 rounded-md border p-2.5">
    <div className="text-muted-foreground text-[9px] tracking-wider uppercase">{label}</div>
    <div className="mt-0.5">{children}</div>
  </div>
);

function Detail({ c }: { c: DebugCapture }) {
  const [v, setV] = useState<(typeof TABS)[number]>("summary");
  return (
    <div className="flex min-h-0 min-w-64 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Badge
            variant={c.kind === "main" ? "default" : "secondary"}
            className="h-5 shrink-0 px-1.5 text-[10px]"
          >
            {c.kind === "main" ? "MAIN AGENT" : (c.subagentType?.toUpperCase() ?? "SUBAGENT")}
          </Badge>
          <span className="text-muted-foreground truncate font-mono text-[11px]">
            {c.model.provider} · {c.model.id}
          </span>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 shrink-0 px-2 text-[11px]"
          onClick={() => dl(`tedi-${stamp(c.at)}.json`, c)}
        >
          Download
        </Button>
      </div>
      <Separator />
      <Tabs
        value={v}
        onValueChange={(s) => setV(s as typeof v)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="h-7 shrink-0">
          {TABS.map((t) => (
            <TabsTrigger key={t} value={t} className="text-[10px]">
              {t[0].toUpperCase() + t.slice(1)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="summary" className="mt-2 min-h-0 flex-1 overflow-auto">
          <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
            <InfoCard label="Provider">{c.model.provider}</InfoCard>
            <InfoCard label="Model">{c.model.id}</InfoCard>
            <InfoCard label="Messages">{msgC(c)}</InfoCard>
            <InfoCard label="Tools">{toolC(c)}</InfoCard>
            <InfoCard label="Timestamp">{new Date(c.at).toLocaleString()}</InfoCard>
            <InfoCard label="Session">{c.sessionId ?? "(none)"}</InfoCard>
            <div className="border-border/50 bg-muted/20 col-span-2 rounded-md border p-2.5">
              <div className="text-muted-foreground text-[9px] tracking-wider uppercase">
                Parameters
              </div>
              <pre className="mt-1 overflow-x-auto text-[10.5px] break-all whitespace-pre-wrap">
                {JSON.stringify(c.params, null, 2)}
              </pre>
            </div>
            {c.tools.length > 0 && (
              <div className="border-border/50 bg-muted/20 col-span-2 rounded-md border p-2.5">
                <div className="text-muted-foreground text-[9px] tracking-wider uppercase">
                  Tools
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {c.tools.map((t) => (
                    <Badge key={t.name} variant="outline" className="text-[10px]">
                      {t.name}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        </TabsContent>
        {["system", "messages", "raw"].map((t) => (
          <TabsContent key={t} value={t} className="mt-2 min-h-0 flex-1">
            <ScrollArea className="border-border/50 bg-muted/20 h-full rounded-md border p-3">
              <pre className="font-mono text-[11px] break-all whitespace-pre-wrap">
                {t === "system"
                  ? c.system
                  : t === "messages"
                    ? JSON.stringify(c.messages, null, 2)
                    : JSON.stringify(c, null, 2)}
              </pre>
            </ScrollArea>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

export function DebugApp() {
  const caps = useDebugStore((s) => s.captures);
  const [sel, setSel] = useState<string | null>(null);
  const [mode, setMode] = useState<"cat" | "sess">("cat");
  const [cat, setCat] = useState("all");
  const [sess, setSess] = useState<string | null>(null);
  const filters = useMemo(() => buildFilters(caps), [caps]);
  const sessions = useMemo(() => groupSessions(caps), [caps]);
  const list = useMemo(
    () =>
      mode === "cat"
        ? filters.find((f) => f.key === cat)
          ? caps.filter(filters.find((f) => f.key === cat)!.fn)
          : caps
        : sess === null
          ? caps
          : caps.filter((c) => (c.sessionId ?? "_") === sess),
    [mode, cat, sess, caps, filters],
  );
  const picked = useMemo(() => list.find((c) => c.id === sel) ?? list[0] ?? null, [list, sel]);

  // Mirror the main window's in-memory captures into this separate webview.
  // (Theme is handled by ThemeProvider, which hydrates from the persistent
  // store on its own - this window doesn't read the preferences store.)
  useEffect(() => startDebugClient(), []);

  // Esc closes the window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void getCurrentWebviewWindow().close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <TooltipProvider>
      <div className="bg-background text-foreground flex h-screen flex-col overflow-hidden select-none">
        <header
          data-tauri-drag-region
          className={`border-border/60 bg-card/60 flex h-11 shrink-0 items-center gap-2 border-b ${
            IS_MAC ? "pr-3 pl-22" : "pr-0 pl-3"
          }`}
        >
          <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2">
            <span className="text-[12px] font-medium">Debug</span>
            <span className="text-muted-foreground truncate text-[11px]">
              requests sent to provider
            </span>
          </div>
          {USE_CUSTOM_WINDOW_CONTROLS && (
            <div className="flex h-full shrink-0 items-center pr-2 pl-1">
              <Button
                variant="ghost"
                size="icon-sm"
                className="bg-secondary hover:bg-destructive/10 hover:text-destructive"
                aria-label="Close"
                onClick={() => void getCurrentWebviewWindow().close()}
              >
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                <span className="sr-only">Close</span>
              </Button>
            </div>
          )}
        </header>

        <main className="flex min-h-0 flex-1 flex-col gap-3 p-3">
          {!caps.length ? (
            <div className="text-muted-foreground flex flex-1 items-center justify-center text-[12px]">
              No requests captured yet.
            </div>
          ) : (
            <>
              <Tabs
                value={mode}
                onValueChange={(v) => setMode(v as typeof mode)}
                className="shrink-0"
              >
                <TabsList className="h-7">
                  <TabsTrigger value="cat" className="text-[10px]">
                    By Category
                  </TabsTrigger>
                  <TabsTrigger value="sess" className="text-[10px]">
                    By Session
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="cat" className="mt-2">
                  <div className="flex flex-wrap gap-1">
                    {filters.map((f) => (
                      <Chip
                        key={f.key}
                        active={cat === f.key}
                        count={f.count}
                        onClick={() => setCat(f.key)}
                      >
                        {f.label}
                      </Chip>
                    ))}
                  </div>
                </TabsContent>
                <TabsContent value="sess" className="mt-2">
                  <div className="flex flex-wrap gap-1">
                    {sessions.map((gp) => (
                      <Chip
                        key={gp.sid ?? "_"}
                        active={sess === gp.sid}
                        count={gp.m + gp.s}
                        onClick={() => setSess(gp.sid)}
                      >
                        {gp.label}{" "}
                        <span className="opacity-60">
                          {gp.m}m/{gp.s}s
                        </span>
                      </Chip>
                    ))}
                  </div>
                </TabsContent>
              </Tabs>
              <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto">
                <ScrollArea className="border-border/60 w-60 shrink-0 rounded-md border">
                  <div className="space-y-1 p-1">
                    {list.length ? (
                      list.map((c) => (
                        <Row
                          key={c.id}
                          c={c}
                          active={picked?.id === c.id}
                          onClick={() => setSel(c.id)}
                        />
                      ))
                    ) : (
                      <div className="text-muted-foreground py-6 text-center text-[11px]">
                        No matches.
                      </div>
                    )}
                  </div>
                </ScrollArea>
                {picked ? (
                  <Detail c={picked} />
                ) : (
                  <div className="text-muted-foreground flex flex-1 items-center justify-center text-[12px]">
                    Select a capture.
                  </div>
                )}
              </div>
            </>
          )}
        </main>

        <div className="border-border/50 grid shrink-0 grid-cols-3 gap-2 border-t p-3">
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-full"
            disabled={!caps.length}
            onClick={() => dl("tedi-all.json", caps)}
          >
            Download all
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-full"
            disabled={!caps.length}
            onClick={() => {
              clearDebugRemote();
              setSel(null);
            }}
          >
            Clear
          </Button>
          <Button
            size="sm"
            className="h-8 w-full"
            onClick={() => void getCurrentWebviewWindow().close()}
          >
            Close
          </Button>
        </div>
        <Toaster />
      </div>
    </TooltipProvider>
  );
}
