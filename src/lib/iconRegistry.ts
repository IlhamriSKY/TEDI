/**
 * Runtime, name-based icon resolution for dynamic call sites: extension tab
 * icons, contributed header/status items, and `ext.ui.icon()`. Static JSX
 * usages import Lucide icons by name directly (tree-shaken into the main
 * chunk); only these dynamic-name lookups route through here.
 *
 * Design mirrors the old HugeIcons barrel: Lucide is pulled in via a dynamic
 * `import("lucide-react")` so its full `icons` record becomes its own Rollup
 * chunk that loads in parallel with the main bundle instead of bloating it.
 *
 * Icon reference forms accepted by `resolveExtIcon`:
 *   - `lucide:<Name>`      new/native, e.g. `lucide:Globe` or `lucide:git-branch`
 *   - `hugeicon:<OldName>` legacy, e.g. `hugeicon:Globe02Icon` (installed
 *                          extensions from before the Lucide migration); mapped
 *                          to the nearest Lucide icon via HUGEICON_ALIAS.
 * Anything else (`data:`, `ext-asset:`, `fileicon:`) is not an icon-name ref
 * and returns null so the caller's asset loader handles it.
 *
 * Lookups are sync with a null fallback: callers render a placeholder on first
 * paint (chunk in flight) and swap to the real icon once the chunk lands.
 * `useIconsReady` / `onIconsReady` give consumers a re-render trigger.
 */
import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";

export type { LucideIcon };

type IconsRecord = Record<string, LucideIcon | undefined>;

let cache: IconsRecord | null = null;
let loadPromise: Promise<IconsRecord> | null = null;
const subscribers = new Set<() => void>();

function startLoad(): Promise<IconsRecord> {
  if (!loadPromise) {
    loadPromise = import("lucide-react")
      .then((m) => {
        cache = m.icons as unknown as IconsRecord;
        const snapshot = Array.from(subscribers);
        subscribers.clear();
        for (const fn of snapshot) {
          try {
            fn();
          } catch (err) {
            console.error("iconRegistry: notify subscriber failed", err);
          }
        }
        return cache;
      })
      .catch((err) => {
        loadPromise = null;
        console.error("iconRegistry: failed to load lucide-react", err);
        throw err;
      });
  }
  return loadPromise;
}

/** kebab-case or suffixed name -> Lucide `icons` key (PascalCase, no suffix). */
function toIconsKey(name: string): string {
  // strip a trailing "Icon" (some refs carry it), then PascalCase any
  // kebab/space separated form. Already-PascalCase names pass through.
  const base = name.replace(/Icon$/, "");
  if (base.includes("-") || base.includes(" ")) {
    return base
      .split(/[-\s]+/)
      .filter(Boolean)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join("");
  }
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * Resolve an extension icon reference to a Lucide component. Returns null for
 * non-icon-name refs, an unknown name, or while the chunk is still loading
 * (kicks off the load on first call).
 */
export function resolveExtIcon(ref: string | undefined | null): LucideIcon | null {
  if (!ref) return null;
  let name: string | null = null;
  if (ref.startsWith("lucide:")) name = ref.slice(7);
  else if (ref.startsWith("hugeicon:")) name = HUGEICON_ALIAS[ref.slice(9)] ?? ref.slice(9);
  else return null;
  if (!name) return null;
  if (!cache) {
    void startLoad();
    return null;
  }
  return cache[toIconsKey(name)] ?? null;
}

/** Subscribe to a one-shot ready signal fired when the lucide chunk lands. */
export function onIconsReady(fn: () => void): () => void {
  if (cache) {
    fn();
    return () => {};
  }
  subscribers.add(fn);
  void startLoad();
  return () => {
    subscribers.delete(fn);
  };
}

/** React hook: `true` once the lucide chunk has loaded. */
export function useIconsReady(): boolean {
  const [ready, setReady] = useState<boolean>(() => cache !== null);
  useEffect(() => {
    if (ready) return;
    return onIconsReady(() => setReady(true));
  }, [ready]);
  return ready;
}

/**
 * Backward-compat: legacy `hugeicon:<Name>` refs from extensions installed
 * before the Lucide migration, mapped to the nearest Lucide icon. New
 * extensions should use `lucide:<Name>`. Unmapped names fall through to a
 * best-effort direct lookup, then the caller's default glyph.
 */
const HUGEICON_ALIAS: Record<string, string> = {
  AbsoluteIcon: "DraftingCompass",
  Add01Icon: "Plus",
  AddSquareIcon: "SquarePlus",
  AiMagicIcon: "WandSparkles",
  AiScanIcon: "ScanSearch",
  Alert01Icon: "TriangleAlert",
  AlertCircleIcon: "CircleAlert",
  ArrowDown01Icon: "ChevronDown",
  ArrowLeft01Icon: "ChevronLeft",
  ArrowReloadHorizontalIcon: "RefreshCw",
  ArrowRight01Icon: "ChevronRight",
  ArrowTurnBackwardIcon: "CornerUpLeft",
  ArrowUp01Icon: "ChevronUp",
  BookmarkAdd02Icon: "BookmarkPlus",
  BookOpenIcon: "BookOpen",
  Calendar01Icon: "Calendar",
  CalendarAdd01Icon: "CalendarPlus",
  Camera01Icon: "Camera",
  Cancel01Icon: "X",
  CancelCircleIcon: "CircleX",
  CancelSquareIcon: "SquareX",
  ChatGptIcon: "Sparkles",
  CheckListIcon: "ListChecks",
  CheckmarkCircle01Icon: "CircleCheck",
  CheckmarkCircle02Icon: "CircleCheck",
  CheckmarkSquare02Icon: "SquareCheckBig",
  ClaudeIcon: "Sparkles",
  Clock01Icon: "Clock",
  Clock04Icon: "Clock",
  CloudServerIcon: "Server",
  CloudUploadIcon: "CloudUpload",
  CodeIcon: "Code",
  ComputerIcon: "Monitor",
  ComputerTerminal02Icon: "SquareTerminal",
  Copy01Icon: "Copy",
  CopyIcon: "Copy",
  CpuIcon: "Cpu",
  Cursor01Icon: "MousePointer2",
  CursorInWindowIcon: "SquareMousePointer",
  DashboardSquare02Icon: "LayoutDashboard",
  Database01Icon: "Database",
  DeepseekIcon: "Sparkles",
  Delete02Icon: "Trash2",
  DocumentCodeIcon: "FileCode",
  Download01Icon: "Download",
  Download04Icon: "Download",
  DragDropVerticalIcon: "GripVertical",
  // The two GENERIC "edit" names both land on the one rename glyph, so an
  // extension installed before the Lucide migration draws the same pencil as
  // everything else in the app. `FileEditIcon` / `FolderEditIcon` below stay on
  // their file/folder-specific pens - those asked for a specific glyph, not for
  // "rename this".
  Edit02Icon: "Pencil",
  EraserIcon: "Eraser",
  EyeIcon: "Eye",
  File01Icon: "File",
  File02Icon: "File",
  FileAddIcon: "FilePlus",
  FileEditIcon: "FilePen",
  FilePlusIcon: "FilePlus",
  FileSearchIcon: "FileSearch",
  FilterIcon: "ListFilter",
  FlashIcon: "Zap",
  Folder01Icon: "Folder",
  Folder02Icon: "Folder",
  FolderAddIcon: "FolderPlus",
  FolderEditIcon: "FolderPen",
  FolderOpenIcon: "FolderOpen",
  FolderUploadIcon: "FolderUp",
  GitBranchIcon: "GitBranch",
  GitCommitIcon: "GitCommitHorizontal",
  GitCompareIcon: "GitCompare",
  GithubIcon: "GitBranch",
  GlobalIcon: "Globe",
  GlobalSearchIcon: "Search",
  Globe02Icon: "Globe",
  GoogleGeminiIcon: "Sparkles",
  Grok02Icon: "Sparkles",
  HashtagIcon: "Hash",
  HelpCircleIcon: "CircleHelp",
  Home02Icon: "House",
  Image01Icon: "Image",
  InformationCircleIcon: "Info",
  InternetIcon: "Globe",
  Key01Icon: "KeyRound",
  KeyboardIcon: "Keyboard",
  Layers01Icon: "Layers",
  LayoutTwoColumnIcon: "Columns2",
  LayoutTwoRowIcon: "Rows2",
  Link01Icon: "Link",
  LinkSquare01Icon: "ExternalLink",
  LinkSquare02Icon: "ExternalLink",
  ListViewIcon: "List",
  Loading03Icon: "LoaderCircle",
  LockedIcon: "Lock",
  MagicWand01Icon: "WandSparkles",
  MagicWand02Icon: "WandSparkles",
  Mic01Icon: "Mic",
  Minimize02Icon: "Minimize2",
  MinusSignIcon: "Minus",
  Moon02Icon: "Moon",
  MoreHorizontalCircle01Icon: "Ellipsis",
  MoreVerticalIcon: "EllipsisVertical",
  MouseLeftClick01Icon: "MousePointerClick",
  Move01Icon: "Move",
  Navigation03Icon: "Compass",
  PaintBoardIcon: "Palette",
  PaintBrush04Icon: "Paintbrush",
  PauseIcon: "Pause",
  PencilEdit01Icon: "Pencil",
  PencilEdit02Icon: "Pencil",
  PinIcon: "Pin",
  PlayCircleIcon: "CirclePlay",
  PlaySquareIcon: "SquarePlay",
  PlusSignIcon: "Plus",
  PuzzleIcon: "Puzzle",
  Refresh01Icon: "RefreshCw",
  RefreshIcon: "RefreshCw",
  ReplaceAllIcon: "Replace",
  ReplaceIcon: "Replace",
  RobotIcon: "Bot",
  RotateClockwiseIcon: "RotateCw",
  ScrollVerticalIcon: "MoveVertical",
  Search01Icon: "Search",
  SearchIcon: "Search",
  SearchReplaceIcon: "Replace",
  SentIcon: "Send",
  Settings01Icon: "Settings",
  ShieldUserIcon: "ShieldUser",
  SidebarLeft01Icon: "PanelLeft",
  SidebarLeftIcon: "PanelLeft",
  SidebarRight01Icon: "PanelRight",
  Sorting02Icon: "ArrowUpDown",
  SparklesIcon: "Sparkles",
  SquareIcon: "Square",
  SquareLock01Icon: "Lock",
  SquareLock02Icon: "Lock",
  StopCircleIcon: "CircleStop",
  Sun03Icon: "Sun",
  TerminalIcon: "Terminal",
  TextWrapIcon: "WrapText",
  Tick02Icon: "Check",
  ToolsIcon: "Wrench",
  UndoIcon: "Undo2",
  UnfoldLessIcon: "ChevronsDownUp",
  UnfoldMoreIcon: "ChevronsUpDown",
  UserMultiple02Icon: "Users",
  ViewIcon: "Eye",
  ViewOffSlashIcon: "EyeOff",
  ZoomIcon: "ZoomIn",
};
