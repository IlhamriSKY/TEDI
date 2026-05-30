import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TOOLBAR_HOVER } from "@/lib/toolbarButton";
import {
  ArrowReloadHorizontalIcon,
  Globe02Icon,
  LinkSquare02Icon,
  Shield01Icon,
  ShieldBanIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { isSelfReferenceUrl, SELF_REFERENCE_NOTICE } from "./lib/proxy";

type PortPreset = {
  port: number;
  label: string;
  hint: string;
};

// Curated dev-server ports. Ordered by frontend frequency, then backend.
const PORT_PRESETS: readonly PortPreset[] = [
  { port: 5173, label: "Vite", hint: "vite, sveltekit" },
  { port: 5174, label: "Vite (alt)", hint: "second vite instance" },
  { port: 3000, label: "Next.js", hint: "next, express, rails" },
  { port: 3001, label: "Next.js (alt)", hint: "second next instance" },
  { port: 4173, label: "Vite preview", hint: "vite preview" },
  { port: 4200, label: "Angular", hint: "angular cli" },
  { port: 4321, label: "Astro", hint: "astro" },
  { port: 5500, label: "Live Server", hint: "vscode live server" },
  { port: 6006, label: "Storybook", hint: "storybook" },
  { port: 8080, label: "Webpack", hint: "webpack, vue cli" },
  { port: 8081, label: "Metro", hint: "react native metro" },
  { port: 8000, label: "Django / FastAPI", hint: "django, fastapi" },
  { port: 8888, label: "Jupyter", hint: "jupyter notebook" },
  { port: 5000, label: "Flask", hint: "flask" },
  { port: 7860, label: "Gradio", hint: "gradio" },
  { port: 11434, label: "Ollama", hint: "ollama api" },
];

export type PreviewAddressBarHandle = {
  focus: () => void;
};

type Props = {
  url: string;
  proxied: boolean;
  canProxy: boolean;
  onSubmit: (url: string) => void;
  onReload: () => void;
  onToggleProxy: () => void;
  ref?: Ref<PreviewAddressBarHandle>;
};

export function PreviewAddressBar({ url, proxied, canProxy, onSubmit, onReload, onToggleProxy, ref }: Props) {
    const [draft, setDraft] = useState(url);
    const inputRef = useRef<HTMLInputElement>(null);

    // Keep draft in sync when the parent updates the URL externally
    // (AI tool, detected localhost chip, etc.).
    useEffect(() => {
      setDraft(url);
    }, [url]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          const el = inputRef.current;
          if (!el) return;
          el.focus();
          el.select();
        },
      }),
      [],
    );

    const [notice, setNotice] = useState<string | null>(null);
    const [checkingPort, setCheckingPort] = useState<number | null>(null);

    const submit = () => {
      const next = normalizeUrl(draft);
      if (!next) {
        setNotice("Enter a URL or pick a port preset.");
        return;
      }
      if (isSelfReferenceUrl(next)) {
        setNotice(SELF_REFERENCE_NOTICE);
        return;
      }
      setNotice(null);
      if (next !== url) onSubmit(next);
      else onReload();
    };

    const tryPort = async (port: number) => {
      setNotice(null);
      const candidate = `http://localhost:${port}`;
      if (isSelfReferenceUrl(candidate)) {
        setNotice(SELF_REFERENCE_NOTICE);
        return;
      }
      setCheckingPort(port);
      const ok = await probeUrl(candidate);
      setCheckingPort(null);
      if (!ok) {
        setNotice(`No server listening on :${port}.`);
        return;
      }
      setDraft(candidate);
      onSubmit(candidate);
    };

    return (
      <div className="border-border/60 shrink-0 border-b">
        <div className="bg-card/40 flex h-9 items-center gap-1 px-1.5">
          <IconTooltip label="Reload" side="bottom">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onReload}
              aria-label="Reload"
              className={`text-muted-foreground ${TOOLBAR_HOVER} size-7 shrink-0 rounded-md`}
            >
              <HugeiconsIcon icon={ArrowReloadHorizontalIcon} size={14} strokeWidth={1.75} />
            </Button>
          </IconTooltip>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="Common dev-server ports"
                    className={`text-muted-foreground ${TOOLBAR_HOVER} h-7 shrink-0 gap-1 rounded-md px-1.5 text-[11px]`}
                  >
                    <HugeiconsIcon icon={Globe02Icon} size={13} strokeWidth={1.75} />
                    <span className="hidden sm:inline">Ports</span>
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">Common dev-server ports</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start" className="max-h-80 min-w-56 overflow-y-auto">
              {PORT_PRESETS.map((p) => (
                <DropdownMenuItem
                  key={p.port}
                  onSelect={(e) => {
                    e.preventDefault();
                    void tryPort(p.port);
                  }}
                >
                  <span className="flex-1">{p.label}</span>
                  <span className="text-muted-foreground text-xs">
                    {checkingPort === p.port ? "checking…" : `:${p.port}`}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="flex min-w-0 flex-1 items-center">
            <Input
              ref={inputRef}
              value={draft}
              placeholder="http://localhost:3000"
              spellCheck={false}
              autoComplete="off"
              className="bg-muted/60 placeholder:text-muted-foreground/70 h-7 w-full px-2 text-xs focus-visible:ring-0"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setDraft(url);
                  inputRef.current?.blur();
                }
              }}
            />
          </div>
          {canProxy ? (
            <IconTooltip
              label={
                proxied
                  ? "Proxied (strips X-Frame-Options). Click to load directly."
                  : "Loading directly. Click to route through proxy."
              }
              side="bottom"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onToggleProxy}
                aria-label={proxied ? "Disable preview proxy" : "Enable preview proxy"}
                aria-pressed={proxied}
                className={
                  proxied
                    ? "hover:bg-accent dark:hover:bg-accent size-7 shrink-0 rounded-md text-diff-added"
                    : `text-muted-foreground ${TOOLBAR_HOVER} size-7 shrink-0 rounded-md`
                }
              >
                <HugeiconsIcon
                  icon={proxied ? Shield01Icon : ShieldBanIcon}
                  size={14}
                  strokeWidth={1.75}
                />
              </Button>
            </IconTooltip>
          ) : null}
          <IconTooltip label="Open in system browser" side="bottom">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => {
                if (url) void openUrl(url).catch(console.error);
              }}
              aria-label="Open in system browser"
              className={`text-muted-foreground ${TOOLBAR_HOVER} size-7 shrink-0 rounded-md`}
              disabled={!url}
            >
              <HugeiconsIcon icon={LinkSquare02Icon} size={14} strokeWidth={1.75} />
            </Button>
          </IconTooltip>
        </div>
        {notice ? (
          <div className="flex items-center gap-1.5 bg-icon-working/8 px-3 py-1 text-[11px] text-icon-working">
            <span className="truncate">{notice}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="hover:bg-accent ml-auto cursor-pointer rounded px-1 text-[10px] opacity-80 hover:opacity-100"
            >
              Dismiss
            </button>
          </div>
        ) : null}
      </div>
    );
  }

async function probeUrl(url: string): Promise<boolean> {
  try {
    await fetch(url, {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      signal: AbortSignal.timeout(900),
    });
    return true;
  } catch {
    return false;
  }
}

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^localhost(:|\/|$)/i.test(trimmed)) return `http://${trimmed}`;
  if (/^\d{1,3}(\.\d{1,3}){3}(:|\/|$)/.test(trimmed)) return `http://${trimmed}`;
  if (/^[\w.-]+\.[a-z]{2,}/i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}
