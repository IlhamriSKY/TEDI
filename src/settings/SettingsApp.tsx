import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { IS_MAC, USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { IPC_EVENTS } from "@/lib/ipc";
import type { SettingsTab } from "@/modules/settings/openSettingsWindow";
import { useExtensionsStore } from "@/modules/extensions";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  AiScanIcon,
  Cancel01Icon,
  CodeIcon,
  InformationCircleIcon,
  PaintBoardIcon,
  PuzzleIcon,
  Settings01Icon,
  UserMultiple02Icon,
  KeyboardIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  Component,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
  lazy,
  Suspense,
  useEffect,
  useState,
} from "react";

const GeneralSection = lazy(() =>
  import("./sections/GeneralSection").then((m) => ({ default: m.GeneralSection })),
);
const CodeEditorSection = lazy(() =>
  import("./sections/CodeEditorSection").then((m) => ({ default: m.CodeEditorSection })),
);
const ThemeSection = lazy(() =>
  import("./sections/ThemeSection").then((m) => ({ default: m.ThemeSection })),
);
const ShortcutsSection = lazy(() =>
  import("./sections/ShortcutsSection").then((m) => ({ default: m.ShortcutsSection })),
);
const ModelsSection = lazy(() =>
  import("./sections/ModelsSection").then((m) => ({ default: m.ModelsSection })),
);
const AgentsSection = lazy(() =>
  import("./sections/AgentsSection").then((m) => ({ default: m.AgentsSection })),
);
const ExtensionsSection = lazy(() =>
  import("./sections/ExtensionsSection").then((m) => ({ default: m.ExtensionsSection })),
);
const AboutSection = lazy(() =>
  import("./sections/AboutSection").then((m) => ({ default: m.AboutSection })),
);

const TABS: {
  id: SettingsTab;
  label: string;
  icon: typeof Settings01Icon;
  component: ComponentType;
}[] = [
  { id: "general", label: "General", icon: Settings01Icon, component: GeneralSection },
  { id: "code-editor", label: "Code Editor", icon: CodeIcon, component: CodeEditorSection },
  { id: "theme", label: "Theme", icon: PaintBoardIcon, component: ThemeSection },
  { id: "shortcuts", label: "Shortcuts", icon: KeyboardIcon, component: ShortcutsSection },
  { id: "models", label: "Models", icon: AiScanIcon, component: ModelsSection },
  { id: "agents", label: "Agents", icon: UserMultiple02Icon, component: AgentsSection },
  { id: "extensions", label: "Extensions", icon: PuzzleIcon, component: ExtensionsSection },
  { id: "about", label: "About", icon: InformationCircleIcon, component: AboutSection },
];

const VALID_TABS: SettingsTab[] = [
  "general",
  "code-editor",
  "theme",
  "shortcuts",
  "models",
  "agents",
  "extensions",
  "about",
];

function readInitialTab(): SettingsTab {
  if (typeof window === "undefined") return "general";
  const url = new URL(window.location.href);
  const t = url.searchParams.get("tab");
  // Back-compat: legacy "ai" / "connections" map to "models". The SSH manager moved to the toolbar.
  if (t === "ai" || t === "connections") return "models";
  if (t && (VALID_TABS as string[]).includes(t)) return t as SettingsTab;
  return "general";
}

/**
 * Catches render-time errors inside a settings tab so a single broken
 * section does not blank the whole window. Resets when the active tab
 * changes (so flipping tabs after fixing data clears the error).
 */
class SectionErrorBoundary extends Component<
  { tabId: string; children: ReactNode },
  { error: Error | null; prevTabId: string }
> {
  state = { error: null as Error | null, prevTabId: this.props.tabId };

  static getDerivedStateFromError(error: Error): { error: Error | null } {
    return { error };
  }

  static getDerivedStateFromProps(
    props: { tabId: string },
    state: { error: Error | null; prevTabId: string },
  ): { error: Error | null; prevTabId: string } | null {
    if (props.tabId !== state.prevTabId) {
      return { error: null, prevTabId: props.tabId };
    }
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Settings section crashed", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="border-destructive/40 bg-destructive/5 flex flex-col gap-2 border p-4">
          <span className="text-destructive text-[12px] font-semibold">
            This section failed to render.
          </span>
          <pre className="text-muted-foreground max-h-40 overflow-auto font-mono text-[10.5px] whitespace-pre-wrap">
            {this.state.error.message}
          </pre>
          <span className="text-muted-foreground text-[10.5px]">
            Switch to another tab and back to retry, or report the issue with the message above.
          </span>
        </div>
      );
    }
    return this.props.children;
  }
}

export function SettingsApp() {
  const [active, setActive] = useState<SettingsTab>(readInitialTab);
  const init = usePreferencesStore((s) => s.init);
  const ActiveSection = TABS.find((t) => t.id === active)?.component;

  useEffect(() => {
    void init();
  }, [init]);

  // Seed extension contribution registries so the Extensions and Shortcuts
  // tabs can render every installed extension's declarations. The Settings
  // window doesn't activate extensions; `init()` handles non-main-window mode.
  useEffect(() => {
    void useExtensionsStore.getState().init();
  }, []);

  useEffect(() => {
    const apply = (detail: string) => {
      if (detail === "ai" || detail === "connections") {
        setActive("models");
        return;
      }
      if ((VALID_TABS as string[]).includes(detail)) {
        setActive(detail as SettingsTab);
      }
    };
    const unlistenPromise = getCurrentWebviewWindow().listen<string>(IPC_EVENTS.SETTINGS_TAB, (e) =>
      apply(e.payload),
    );
    return () => {
      void unlistenPromise.then((un) => un());
    };
  }, []);

  return (
    <TooltipProvider>
      {/* Outer border lives on `#settings-root` via globals.css; doing it on
          the inner root would clip 2px under `h-screen`. macOS keeps native chrome. */}
      <div className="bg-background text-foreground flex h-screen flex-col overflow-hidden select-none">
        {/* Header: just a title + close, matching the Debug window. The tab nav
            lives in the body below (not the header), also like Debug. */}
        <header
          data-tauri-drag-region
          className={`border-border/60 bg-card/60 flex h-11 shrink-0 items-center gap-2 border-b ${
            IS_MAC ? "pr-3 pl-22" : "pr-0 pl-3"
          }`}
        >
          <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2">
            <span className="text-[12px] font-medium">Settings</span>
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

        <main className="flex min-h-0 flex-1 flex-col">
          <Tabs
            value={active}
            onValueChange={(v) => setActive(v as SettingsTab)}
            orientation="horizontal"
            className="flex shrink-0 items-center overflow-x-auto px-4 pt-3 pb-1"
          >
            <TabsList className="bg-muted/40 h-7 px-2">
              {TABS.map((t) => (
                <TabsTrigger key={t.id} value={t.id} className="h-6 gap-1.5 px-2.5 text-[11.5px]">
                  <HugeiconsIcon icon={t.icon} size={12} strokeWidth={1.75} />
                  <span>{t.label}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="themed-scroll min-h-0 flex-1 overflow-auto px-8 pt-4 pb-7">
            <div className="mx-auto w-full max-w-3xl">
              <SectionErrorBoundary tabId={active}>
                <Suspense fallback={null}>{ActiveSection && <ActiveSection />}</Suspense>
              </SectionErrorBoundary>
            </div>
          </div>
        </main>
      </div>
    </TooltipProvider>
  );
}
