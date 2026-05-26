import { useEffect, useState } from "react";
import { EXT_TO_LANGUAGE_ID } from "./constants";
import * as fileIconsMod from "./fileIcons";
import * as folderIconsMod from "./folderIcons";

const catFileNames = fileIconsMod.fileNames as Record<string, string>;
const catFileExtensions = fileIconsMod.fileExtensions as Record<string, string>;
const catLanguageIds = fileIconsMod.languageIds as Record<string, string>;
const catFolderNames = folderIconsMod.folderNames as Record<string, string>;

type IconifySet = {
  icons: Record<string, { body: string }>;
  aliases?: Record<string, { parent: string }>;
  width?: number;
  height?: number;
};

// Catppuccin's icons.json is ~300 KB. Importing it statically lands the
// whole payload in the eager main chunk, which delays first paint. Pull it
// in via a dynamic import so Rollup splits it into its own chunk that
// streams in parallel. `cat` is `null` for the first few ms after boot;
// `fileIconUrl`/`folderIconUrl` return an empty string while it's in flight
// and `useExplorerIconsReady` lets consumers re-render once it lands.
let cat: IconifySet | null = null;
let catW = 16;
let catH = 16;
let loadPromise: Promise<void> | null = null;
const readySubscribers = new Set<() => void>();

function startLoad(): Promise<void> {
  if (!loadPromise) {
    loadPromise = import("@iconify-json/catppuccin/icons.json")
      .then((m) => {
        const set = (m as { default: unknown }).default as IconifySet;
        cat = set;
        catW = set.width ?? 16;
        catH = set.height ?? 16;
        const snapshot = Array.from(readySubscribers);
        readySubscribers.clear();
        for (const fn of snapshot) {
          try {
            fn();
          } catch (err) {
            console.error("iconResolver: notify subscriber failed", err);
          }
        }
      })
      .catch((err) => {
        loadPromise = null;
        console.error("iconResolver: failed to load catppuccin icons", err);
      });
  }
  return loadPromise;
}

// Kick off the load eagerly at module import so the chunk is in flight by
// the time the first consumer renders.
void startLoad();

/**
 * React hook returning `true` once the catppuccin icon set has loaded.
 * Components that render file/folder icons should call this so their JSX
 * re-renders with real glyphs when the chunk arrives.
 */
export function useExplorerIconsReady(): boolean {
  const [ready, setReady] = useState<boolean>(() => cat !== null);
  useEffect(() => {
    if (ready) return;
    const onReady = () => setReady(true);
    if (cat !== null) {
      onReady();
      return;
    }
    readySubscribers.add(onReady);
    void startLoad();
    return () => {
      readySubscribers.delete(onReady);
    };
  }, [ready]);
  return ready;
}

const DEFAULT_FILE = "file";
const DEFAULT_FOLDER = "folder";
const DEFAULT_FOLDER_OPEN = "folder-open";

const dataUrlCache = new Map<string, string>();

// Catppuccin's manifest emits names like `folder_src`/`typescript-react`, but
// the iconify export normalizes everything to hyphenated slugs.
function toIconifySlug(name: string): string {
  return name.replace(/_/g, "-");
}

function catBody(iconName: string): string | null {
  if (!cat) return null;
  const slug = toIconifySlug(iconName);
  const direct = cat.icons[slug];
  if (direct) return direct.body;
  const alias = cat.aliases?.[slug];
  if (alias) {
    const parent = cat.icons[alias.parent];
    if (parent) return parent.body;
  }
  return null;
}

function buildDataUrl(iconName: string): string | null {
  // Skip the cache write while the catppuccin chunk is still in flight.
  // Caching `""` here would freeze the icon name to "missing" even after
  // the chunk lands; better to keep retrying until `cat` is populated.
  if (!cat) return null;
  const cached = dataUrlCache.get(iconName);
  if (cached !== undefined) return cached || null;
  const body = catBody(iconName);
  if (!body) {
    dataUrlCache.set(iconName, "");
    return null;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${catW} ${catH}">${body}</svg>`;
  const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  dataUrlCache.set(iconName, url);
  return url;
}

function extOf(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.indexOf(".");
  if (dot === -1 || dot === lower.length - 1) return "";
  return lower.slice(dot + 1);
}

export function fileIconUrl(name: string): string {
  const lower = name.toLowerCase();

  const byName = catFileNames[lower];
  if (byName) {
    const url = buildDataUrl(byName);
    if (url) return url;
  }

  let ext = extOf(lower);
  while (ext) {
    const iconName = catFileExtensions[ext];
    if (iconName) {
      const url = buildDataUrl(iconName);
      if (url) return url;
    }
    const langId = EXT_TO_LANGUAGE_ID[ext];
    if (langId) {
      const iconByLang = catLanguageIds[langId];
      if (iconByLang) {
        const url = buildDataUrl(iconByLang);
        if (url) return url;
      }
    }
    const nextDot = ext.indexOf(".");
    if (nextDot === -1) break;
    ext = ext.slice(nextDot + 1);
  }

  return buildDataUrl(DEFAULT_FILE) ?? "";
}

export function folderIconUrl(name: string, expanded: boolean): string {
  const lower = name.toLowerCase();

  const mapped = catFolderNames[lower];
  if (mapped) {
    const slug = toIconifySlug(mapped);
    const target = expanded ? `${slug}-open` : slug;
    const url = buildDataUrl(target);
    if (url) return url;
  }

  return buildDataUrl(expanded ? DEFAULT_FOLDER_OPEN : DEFAULT_FOLDER) ?? "";
}
