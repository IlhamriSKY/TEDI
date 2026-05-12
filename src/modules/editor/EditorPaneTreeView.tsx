import { Fragment } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { EditorPane, type EditorPaneHandle } from "./EditorPane";
import type { EditorPaneNode } from "./lib/panes";

type LeafBundle = {
  setRef: (h: EditorPaneHandle | null) => void;
  onDirty: (dirty: boolean) => void;
  onClose: () => void;
};

type Props = {
  node: EditorPaneNode;
  activeLeafId: number;
  onFocusLeaf: (leafId: number) => void;
  getBundle: (leafId: number) => LeafBundle;
};

export function EditorPaneTreeView({
  node,
  activeLeafId,
  onFocusLeaf,
  getBundle,
}: Props) {
  if (node.kind === "leaf") {
    const focused = node.id === activeLeafId;
    const b = getBundle(node.id);
    return (
      <div
        onMouseDownCapture={() => {
          if (!focused) onFocusLeaf(node.id);
        }}
        onFocus={() => {
          if (!focused) onFocusLeaf(node.id);
        }}
        data-editor-leaf={node.id}
        className={cn(
          "relative h-full w-full overflow-hidden rounded-md border bg-background",
          focused ? "border-primary/40" : "border-border/60",
        )}
      >
        <EditorPane
          ref={b.setRef}
          path={node.path}
          onDirtyChange={b.onDirty}
          onClose={b.onClose}
        />
      </div>
    );
  }

  return (
    <ResizablePanelGroup
      orientation={node.dir === "row" ? "horizontal" : "vertical"}
    >
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 && <ResizableHandle />}
          <ResizablePanel id={`editor-pane-${child.id}`} minSize="10%">
            <EditorPaneTreeView
              node={child}
              activeLeafId={activeLeafId}
              onFocusLeaf={onFocusLeaf}
              getBundle={getBundle}
            />
          </ResizablePanel>
        </Fragment>
      ))}
    </ResizablePanelGroup>
  );
}
