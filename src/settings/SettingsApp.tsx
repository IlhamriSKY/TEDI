import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { IS_MAC, USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import type { SettingsTab } from "@/modules/settings/openSettingsWindow";
import { useExtensionsStore } from "@/modules/extensions";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  AiScanIcon,
  Cancel01Icon,
  InformationCircleIcon,
  PuzzleIcon,
  Settings01Icon,
  UserMultiple02Icon,
  KeyboardIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ComponentType, lazy, Suspense, useEffect, useState } from "react";

const GeneralSection = lazy(() =>
  import("./sections/GeneralSection").then((m) => ({ default: m.GeneralSection })),
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
  { id: "shortcuts", label: "Shortcuts", icon: KeyboardIcon, component: ShortcutsSection },
  { id: "models", label: "Models", icon: AiScanIcon, component: ModelsSection },
  { id: "agents", label: "Agents", icon: UserMultiple02Icon, component: AgentsSection },
  { id: "extensions", label: "Extensions", icon: PuzzleIcon, component: ExtensionsSection },
  { id: "about", label: "About", icon: InformationCircleIcon, component: AboutSection },
];

const VALID_TABS: SettingsTab[] = [
  "general",
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
    const unlistenPromise = getCurrentWebviewWindow().listen<string>("tedi:settings-tab", (e) =>
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
        <header
          data-tauri-drag-region
          className={`border-border/60 bg-card/60 flex h-11 shrink-0 items-center border-b ${
            IS_MAC ? "pr-3 pl-22" : "pr-0 pl-3"
          }`}
        >
          <Tabs
            value={active}
            onValueChange={(v) => setActive(v as SettingsTab)}
            orientation="horizontal"
            className="flex-1 items-center"
            data-tauri-drag-region
          >
            <TabsList className="bg-muted/40 mx-auto h-7 px-2">
              {TABS.map((t) => (
                <TabsTrigger key={t.id} value={t.id} className="h-6 gap-1.5 px-2.5 text-[11.5px]">
                  <HugeiconsIcon icon={t.icon} size={12} strokeWidth={1.75} />
                  <span>{t.label}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
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

        <main className="themed-scroll min-h-0 flex-1 overflow-y-auto px-8 pt-6 pb-7">
          <div className="mx-auto w-full max-w-3xl">
            <Suspense fallback={null}>{ActiveSection && <ActiveSection />}</Suspense>
          </div>
        </main>
      </div>
    </TooltipProvider>
  );
}
