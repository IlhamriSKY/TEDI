/**
 * Everything the status bar's right side can draw, as one flat list of
 * individually placeable entries.
 *
 * This exists because the bar used to be five hard-coded groups: an item's
 * position was decided by which component happened to render it, so "put the
 * memory meter next to the AI usage meters" was a code change. The zones own
 * placement now (see `layout.ts`), and placement needs one addressable node per
 * item rather than five components that each render a row.
 *
 * An entry whose component renders `null` (zoom at 100%, no update waiting, an
 * idle agent) still appears here, and the zone drops it: an empty group leaves
 * no divider behind because `.sb-group:empty` says so.
 */
import { AgentStatusPill } from "@/modules/ai/components/AgentStatusPill";
import { AiOpenButton } from "@/modules/ai/components/AiStatusBarControls";
import {
  useBuiltinSectionToggleEntries,
  useRightPanelToggleEntries,
  useSidebarSectionToggleEntries,
  useStatusItemEntries,
} from "@/modules/extensions";
import { SchedulerStatusPill } from "@/modules/scheduler";
import { UpdaterPill } from "@/modules/updater";
import { ZoomControl } from "./ZoomControl";
import type { StatusZone, ZoneItem } from "./layout";

/** A placeable entry: what the layout needs, plus what to draw. */
export type StatusBarEntry = ZoneItem & { node: React.ReactNode };

/**
 * TEDI's own AI. Both halves live in the locked zone: the button is the one
 * control the bar exists to keep reachable, and the pill is that same agent's
 * status - a bar that folded away a pending approval while keeping the button
 * that opens it would hide the one thing asking for attention.
 */
const AI_IDS = { pill: "ai:agent", button: "ai:panel" } as const;

export function useStatusBarEntries({
  onOpenMini,
  aiPanelOpen,
  onToggleAiPanel,
  scm,
  ssh,
}: {
  onOpenMini: () => void;
  /** See `StatusBar`'s props: the panel's ON SCREEN state, not `panelOpen`. */
  aiPanelOpen: boolean;
  onToggleAiPanel: () => void;
  /** The two built-in right-slot buttons. Passed in rather than imported so
   *  this module stays free of the SCM and SSH stores. */
  scm: React.ReactNode;
  ssh: React.ReactNode;
}): StatusBarEntry[] {
  const statusItems = useStatusItemEntries();
  const panelToggles = useRightPanelToggleEntries();
  const sectionToggles = useSidebarSectionToggleEntries();
  const builtinToggles = useBuiltinSectionToggleEntries();

  const entry = (id: string, defaultZone: StatusZone, node: React.ReactNode) => ({
    id,
    defaultZone,
    node,
  });

  return [
    // --- 0: kept when the bar folds ------------------------------------
    // An update prompt is the one thing here that asks something of you, and a
    // zoom pill is the only way back to 100% that is not a keyboard shortcut -
    // both belong with what a folded bar keeps.
    entry("updater", 0, <UpdaterPill />),
    entry("zoom", 0, <ZoomControl />),
    // A meter is a reading you glance at deliberately; a bare icon is a light
    // that only matters when it changes. That is the whole split between what
    // a folded bar keeps and what it drops, and it is the same test the
    // tooltip ordering already uses.
    ...statusItems.map((e) => entry(e.id, e.meter ? 0 : 1, e.node)),

    // --- 1: folds away --------------------------------------------------
    entry("scheduler", 1, <SchedulerStatusPill />),
    ...panelToggles.map((e) => entry(e.id, 1, e.node)),
    ...sectionToggles.map((e) => entry(e.id, 1, e.node)),
    ...builtinToggles.map((e) => entry(e.id, 1, e.node)),
    entry("scm", 1, scm),
    entry("ssh", 1, ssh),

    // --- 2: AI, locked ---------------------------------------------------
    entry(AI_IDS.pill, 2, <AgentStatusPill onClick={onOpenMini} />),
    entry(AI_IDS.button, 2, <AiOpenButton onToggle={onToggleAiPanel} active={aiPanelOpen} />),
  ];
}
