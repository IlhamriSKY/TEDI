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
import { useChatStore } from "@/modules/ai";
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
 * TEDI's own AI, pinned so compact mode keeps it wherever it was dragged. The
 * agent pill rides the same flag: it is the AI's status, and a bar that folds
 * away a pending approval while keeping the button that opens it would hide the
 * one thing that was asking for attention.
 */
const AI_IDS = { pill: "ai:agent", button: "ai:panel" } as const;

export function useStatusBarEntries({
  onOpenMini,
  scm,
  ssh,
}: {
  onOpenMini: () => void;
  /** The two built-in right-slot buttons. Passed in rather than imported so
   *  this module stays free of the SCM and SSH stores. */
  scm: React.ReactNode;
  ssh: React.ReactNode;
}): StatusBarEntry[] {
  const panelOpen = useChatStore((s) => s.panelOpen);
  const togglePanel = useChatStore((s) => s.togglePanel);

  const statusItems = useStatusItemEntries();
  const panelToggles = useRightPanelToggleEntries();
  const sectionToggles = useSidebarSectionToggleEntries();
  const builtinToggles = useBuiltinSectionToggleEntries();

  const entry = (id: string, defaultZone: StatusZone, node: React.ReactNode, pinned?: boolean) => ({
    id,
    defaultZone,
    node,
    ...(pinned ? { pinned: true } : {}),
  });

  return [
    // --- 0: readouts ----------------------------------------------------
    // An update prompt is the one thing here that asks something of you, and a
    // zoom pill is the only way back to 100% that is not a keyboard shortcut -
    // both belong with what a folded bar keeps.
    entry("updater", 0, <UpdaterPill />),
    entry("zoom", 0, <ZoomControl />),
    entry(AI_IDS.pill, 0, <AgentStatusPill onClick={onOpenMini} />, true),
    // A meter is a reading; a bare icon is a light. That is the whole split
    // between zone 0 and zone 1, and it is the same test the compact bar and
    // the tooltip ordering already use.
    ...statusItems.map((e) => entry(e.id, e.meter ? 0 : 1, e.node)),

    // --- 1: indicators --------------------------------------------------
    entry("scheduler", 1, <SchedulerStatusPill />),

    // --- 2: actions -----------------------------------------------------
    ...panelToggles.map((e) => entry(e.id, 2, e.node)),
    ...sectionToggles.map((e) => entry(e.id, 2, e.node)),
    ...builtinToggles.map((e) => entry(e.id, 2, e.node)),
    entry("scm", 2, scm),
    entry("ssh", 2, ssh),
    entry(AI_IDS.button, 2, <AiOpenButton onToggle={togglePanel} active={panelOpen} />, true),
  ];
}
