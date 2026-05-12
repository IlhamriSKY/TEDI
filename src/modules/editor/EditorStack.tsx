import { cn } from "@/lib/utils";
import type { EditorTab, Tab } from "@/modules/tabs";
import { useEffect, useRef } from "react";
import type { EditorPaneHandle } from "./EditorPane";
import { EditorPaneTreeView } from "./EditorPaneTreeView";
import { leafIds } from "./lib/panes";

type Props = {
  tabs: Tab[];
  activeId: number;
  /**
   * Called per **leaf** (not per tab). With splits, a single editor tab
   * has multiple panes — each registers under its own leaf id.
   */
  onDirtyChange: (leafId: number, dirty: boolean) => void;
  registerHandle: (leafId: number, handle: EditorPaneHandle | null) => void;
  /** User triggered "close pane" from the editor (e.g. vim :q). */
  onCloseLeaf: (leafId: number) => void;
  onFocusLeaf: (tabId: number, leafId: number) => void;
};

type Bundle = {
  setRef: (h: EditorPaneHandle | null) => void;
  onDirty: (dirty: boolean) => void;
  onClose: () => void;
};

export function EditorStack({
  tabs,
  activeId,
  onDirtyChange,
  registerHandle,
  onCloseLeaf,
  onFocusLeaf,
}: Props) {
  const editors = tabs.filter((t): t is EditorTab => t.kind === "editor");

  // Stable callback refs — recreating arrow callbacks per render makes React
  // detach/reattach the ref callback and re-invoke onDirtyChange, which can
  // cause setState loops in the parent.
  const registerRef = useRef(registerHandle);
  const dirtyRef = useRef(onDirtyChange);
  const closeRef = useRef(onCloseLeaf);
  useEffect(() => {
    registerRef.current = registerHandle;
  }, [registerHandle]);
  useEffect(() => {
    dirtyRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => {
    closeRef.current = onCloseLeaf;
  }, [onCloseLeaf]);

  const bundles = useRef(new Map<number, Bundle>());
  const getBundle = (leafId: number): Bundle => {
    let b = bundles.current.get(leafId);
    if (!b) {
      b = {
        setRef: (h) => registerRef.current(leafId, h),
        onDirty: (d) => dirtyRef.current(leafId, d),
        onClose: () => closeRef.current(leafId),
      };
      bundles.current.set(leafId, b);
    }
    return b;
  };

  useEffect(() => {
    const live = new Set<number>();
    for (const t of editors) for (const id of leafIds(t.paneTree)) live.add(id);
    for (const id of bundles.current.keys()) {
      if (!live.has(id)) bundles.current.delete(id);
    }
  }, [editors]);

  if (editors.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {editors.map((t) => {
        const visible = t.id === activeId;
        return (
          <div
            key={t.id}
            className={cn(
              "absolute inset-0",
              !visible && "invisible pointer-events-none",
            )}
            aria-hidden={!visible ? "true" : "false"}
          >
            <EditorPaneTreeView
              node={t.paneTree}
              activeLeafId={t.activeLeafId}
              onFocusLeaf={(leafId) => onFocusLeaf(t.id, leafId)}
              getBundle={getBundle}
            />
          </div>
        );
      })}
    </div>
  );
}
