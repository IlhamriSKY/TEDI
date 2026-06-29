import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, WIDE_DIALOG_WIDTH } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useDebugStore, type DebugCapture } from "../store/debugStore";

const dl = (f: string, d: unknown) => { const u = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)])); const a = document.createElement("a"); a.href = u; a.download = f; document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(u); };
const msgC = (c: DebugCapture) => Array.isArray(c.messages) ? c.messages.length : 0;
const toolC = (c: DebugCapture) => c.tools?.length ?? 0;
const trunc = (s: string, n = 8) => s.length > n ? `${s.slice(0, n)}…` : s;
const stamp = (t: number) => new Date(t).toISOString().replace(/[:.]/g, "-");

type Filter = { key: string; label: string; count: number; fn: (c: DebugCapture) => boolean };

function buildFilters(caps: DebugCapture[]): Filter[] {
  const subs = [...new Set(caps.filter(c => c.kind === "subagent" && c.subagentType).map(c => c.subagentType!))];
  return [{ key: "all", label: "All", count: caps.length, fn: () => true }, { key: "main", label: "Main Agent", count: caps.filter(c => c.kind === "main").length, fn: c => c.kind === "main" }, ...subs.map(t => ({ key: `sub:${t}`, label: t[0].toUpperCase() + t.slice(1), count: caps.filter(c => c.kind === "subagent" && c.subagentType === t).length, fn: (c: DebugCapture) => c.kind === "subagent" && c.subagentType === t }))];
}

function groupSessions(caps: DebugCapture[]): { sid: string | null; label: string; m: number; s: number }[] {
  const map = new Map<string, DebugCapture[]>();
  for (const c of caps) { const k = c.sessionId ?? "_"; (map.get(k) ?? map.set(k, []).get(k)!).push(c); }
  return [...map.entries()].map(([k, v]) => ({ sid: k === "_" ? null : k, label: k === "_" ? "(none)" : trunc(k), m: v.filter(c => c.kind === "main").length, s: v.length - v.filter(c => c.kind === "main").length }));
}

function Chip({ active, count, children, onClick }: { active: boolean; count: number; children: React.ReactNode; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={cn("rounded-md border px-2 py-1 text-[10.5px] transition-colors", active ? "border-foreground/30 bg-accent font-medium" : "border-border/50 text-muted-foreground hover:bg-accent/40")}><span className="mr-1">{children}</span><span className="opacity-60">{count}</span></button>;
}

function Row({ c, active, onClick }: { c: DebugCapture; active: boolean; onClick: () => void }) {
  const d = new Date(c.at);
  return (<button type="button" onClick={onClick} className={cn("flex w-full flex-col gap-1 rounded-md border px-2.5 py-2 text-left transition-colors", active ? "border-foreground/30 bg-accent" : "border-border/50 hover:bg-accent/40")}>
    <div className="flex items-center gap-1.5"><Badge variant={c.kind === "main" ? "default" : "secondary"} className="h-4 px-1 text-[9px] leading-none">{c.kind === "main" ? "MAIN" : c.subagentType ?? "SUB"}</Badge><span className="truncate text-[11.5px] font-medium">{c.model.id}</span></div>
    <div className="flex items-center gap-2 text-muted-foreground font-mono text-[10px]"><span>{d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} {d.toLocaleTimeString()}</span><span className="text-muted-foreground/50">·</span><span>{msgC(c)} msg</span><span className="text-muted-foreground/50">·</span><span>{toolC(c)} tools</span></div>
  </button>);
}

const TABS = ["summary", "system", "messages", "raw"] as const;
const InfoCard = ({ label, children }: { label: string; children: React.ReactNode }) => (<div className="rounded-md border border-border/50 bg-muted/20 p-2.5"><div className="text-muted-foreground text-[9px] uppercase tracking-wider">{label}</div><div className="mt-0.5">{children}</div></div>);

function Detail({ c }: { c: DebugCapture }) {
  const [v, setV] = useState<typeof TABS[number]>("summary");
  return (<div className="flex min-w-0 flex-1 flex-col gap-2">
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2"><Badge variant={c.kind === "main" ? "default" : "secondary"} className="h-5 px-1.5 text-[10px]">{c.kind === "main" ? "MAIN AGENT" : c.subagentType?.toUpperCase() ?? "SUBAGENT"}</Badge><span className="text-muted-foreground font-mono text-[11px]">{c.model.provider} · {c.model.id}</span></div>
      <Button type="button" size="sm" variant="outline" className="h-7 shrink-0 px-2 text-[11px]" onClick={() => dl(`tedi-${stamp(c.at)}.json`, c)}>Download</Button>
    </div>
    <Separator />
    <Tabs value={v} onValueChange={s => setV(s as typeof v)}>
      <TabsList className="h-7">{TABS.map(t => <TabsTrigger key={t} value={t} className="text-[10px]">{t[0].toUpperCase() + t.slice(1)}</TabsTrigger>)}</TabsList>
      <TabsContent value="summary" className="mt-2">
        <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
          <InfoCard label="Provider">{c.model.provider}</InfoCard>
          <InfoCard label="Model">{c.model.id}</InfoCard>
          <InfoCard label="Messages">{msgC(c)}</InfoCard>
          <InfoCard label="Tools">{toolC(c)}</InfoCard>
          <InfoCard label="Timestamp">{new Date(c.at).toLocaleString()}</InfoCard>
          <InfoCard label="Session">{c.sessionId ?? "(none)"}</InfoCard>
          <div className="col-span-2 rounded-md border border-border/50 bg-muted/20 p-2.5"><div className="text-muted-foreground text-[9px] uppercase tracking-wider">Parameters</div><pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all text-[10.5px]">{JSON.stringify(c.params, null, 2)}</pre></div>
          {c.tools.length > 0 && <div className="col-span-2 rounded-md border border-border/50 bg-muted/20 p-2.5"><div className="text-muted-foreground text-[9px] uppercase tracking-wider">Tools</div><div className="mt-1 flex flex-wrap gap-1">{c.tools.map(t => <Badge key={t.name} variant="outline" className="text-[10px]">{t.name}</Badge>)}</div></div>}
        </div>
      </TabsContent>
      {["system", "messages", "raw"].map(t => <TabsContent key={t} value={t} className="mt-2"><ScrollArea className="max-h-[400px] rounded-md border border-border/50 bg-muted/20 p-3"><pre className="whitespace-pre-wrap break-all font-mono text-[11px]">{t === "system" ? c.system : t === "messages" ? JSON.stringify(c.messages, null, 2) : JSON.stringify(c, null, 2)}</pre></ScrollArea></TabsContent>)}
    </Tabs>
  </div>);
}

export function DebugRequestViewer() {
  const enabled = usePreferencesStore(s => s.debugEnabled);
  const caps = useDebugStore(s => s.captures);
  const clear = useDebugStore(s => s.clear);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [mode, setMode] = useState<"cat" | "sess">("cat");
  const [cat, setCat] = useState("all");
  const [sess, setSess] = useState<string | null>(null);
  const filters = useMemo(() => buildFilters(caps), [caps]);
  const sessions = useMemo(() => groupSessions(caps), [caps]);
  const list = useMemo(() => mode === "cat" ? filters.find(f => f.key === cat) ? caps.filter(filters.find(f => f.key === cat)!.fn) : caps : sess === null ? caps : caps.filter(c => (c.sessionId ?? "_") === sess), [mode, cat, sess, caps, filters]);
  const picked = useMemo(() => list.find(c => c.id === sel) ?? list[0] ?? null, [list, sel]);
  useMemo(() => { if (list.length && !list.find(c => c.id === sel)) setSel(list[0].id); else if (!list.length) setSel(null); }, [list, sel]);
  if (!enabled) return null;
  return (<><Button type="button" variant="ghost" size="sm" className="text-muted-foreground h-7 shrink-0 px-2 text-[11px]" onClick={() => setOpen(true)}>Debug{caps.length ? ` · ${caps.length}` : ""}</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className={cn("flex max-h-[90vh] flex-col gap-4 overflow-hidden", WIDE_DIALOG_WIDTH)}>
      <DialogHeader><DialogTitle className="text-[14px]">Debug · requests sent to provider</DialogTitle></DialogHeader>
      {!caps.length ? <div className="text-muted-foreground py-10 text-center text-[12px]">No requests captured yet.</div> : <div className="flex min-h-0 flex-1 flex-col gap-3">
        <Tabs value={mode} onValueChange={v => setMode(v as typeof mode)}>
          <TabsList className="h-7 shrink-0"><TabsTrigger value="cat" className="text-[10px]">By Category</TabsTrigger><TabsTrigger value="sess" className="text-[10px]">By Session</TabsTrigger></TabsList>
          <TabsContent value="cat" className="mt-2"><div className="flex flex-wrap gap-1">{filters.map(f => <Chip key={f.key} active={cat === f.key} count={f.count} onClick={() => setCat(f.key)}>{f.label}</Chip>)}</div></TabsContent>
          <TabsContent value="sess" className="mt-2"><div className="flex flex-wrap gap-1">{sessions.map(g => <Chip key={g.sid ?? "_"} active={sess === g.sid} count={g.m + g.s} onClick={() => setSess(g.sid)}>{g.label} <span className="opacity-60">{g.m}m/{g.s}s</span></Chip>)}</div></TabsContent>
        </Tabs>
        <div className="flex min-h-0 flex-1 gap-3">
          <ScrollArea className="w-64 shrink-0 border-r border-border/60 pr-2"><div className="space-y-1 py-1">{list.length ? list.map(c => <Row key={c.id} c={c} active={picked?.id === c.id} onClick={() => setSel(c.id)} />) : <div className="text-muted-foreground py-6 text-center text-[11px]">No matches.</div>}</div></ScrollArea>
          {picked ? <Detail c={picked} /> : <div className="text-muted-foreground flex flex-1 items-center justify-center text-[12px]">Select a capture.</div>}
        </div>
      </div>}
      <DialogFooter className="grid grid-cols-1 gap-2 border-t border-border/50 pt-4 sm:grid-cols-3">
        <Button variant="outline" className="h-9 w-full" disabled={!caps.length} onClick={() => dl("tedi-all.json", caps)}>Download all</Button>
        <Button variant="outline" className="h-9 w-full" disabled={!caps.length} onClick={() => { clear(); setSel(null); }}>Clear</Button>
        <Button className="h-9 w-full" onClick={() => setOpen(false)}>Close</Button>
      </DialogFooter>
    </DialogContent></Dialog></>);
}
