import { Fragment } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { EditorPane, type EditorPaneHandle } from "@/modules/editor";
import { TerminalPane, type TerminalPaneHandle } from "@/modules/terminal";
import type { SearchAddon } from "@xterm/addon-search";
import type { PaneNode } from "@/modules/terminal/lib/panes";
import type {
  TeraxOpenInput,
  TeraxSpawnTabInput,
} from "@/modules/terminal/lib/useTerminalSession";

export type LeafBundle = {
  // terminal-only
  setTerminalRef: (h: TerminalPaneHandle | null) => void;
  onSearchReady: (addon: SearchAddon) => void;
  onCwd: (cwd: string) => void;
  onDetectedLocalUrl: (url: string) => void;
  onExit: (code: number) => void;
  onTeraxOpen: (input: TeraxOpenInput) => void;
  onTeraxSpawnTab: (input: TeraxSpawnTabInput) => void;
  // editor-only
  setEditorRef: (h: EditorPaneHandle | null) => void;
  onDirtyChange: (dirty: boolean) => void;
  onCloseLeaf: () => void;
};

type Props = {
  node: PaneNode;
  tabVisible: boolean;
  activeLeafId: number;
  onFocusLeaf: (leafId: number) => void;
  getBundle: (leafId: number) => LeafBundle;
};

export function PaneTreeView({
  node,
  tabVisible,
  activeLeafId,
  onFocusLeaf,
  getBundle,
}: Props) {
  if (node.kind === "leaf") {
    const focused = node.id === activeLeafId;
    const b = getBundle(node.id);
    if (node.leafKind === "terminal") {
      return (
        <div
          onMouseDownCapture={() => {
            if (!focused) onFocusLeaf(node.id);
          }}
          onFocus={() => {
            if (!focused) onFocusLeaf(node.id);
          }}
          data-pane-leaf={node.id}
          className="relative h-full w-full"
        >
          <TerminalPane
            leafId={node.id}
            visible={tabVisible}
            focused={focused}
            initialCwd={node.cwd}
            ref={b.setTerminalRef}
            onSearchReady={(_id, addon) => b.onSearchReady(addon)}
            onCwd={(_id, cwd) => b.onCwd(cwd)}
            onDetectedLocalUrl={(_id, url) => b.onDetectedLocalUrl(url)}
            onExit={(_id, code) => b.onExit(code)}
            onTeraxOpen={(_id, input) => b.onTeraxOpen(input)}
            onTeraxSpawnTab={(_id, input) => b.onTeraxSpawnTab(input)}
          />
        </div>
      );
    }
    // editor leaf
    return (
      <div
        onMouseDownCapture={() => {
          if (!focused) onFocusLeaf(node.id);
        }}
        onFocus={() => {
          if (!focused) onFocusLeaf(node.id);
        }}
        data-pane-leaf={node.id}
        className={cn(
          "relative h-full w-full overflow-hidden rounded-md border bg-background",
          focused ? "border-primary/40" : "border-border/60",
        )}
      >
        <EditorPane
          ref={b.setEditorRef}
          path={node.path}
          onDirtyChange={b.onDirtyChange}
          onClose={b.onCloseLeaf}
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
          <ResizablePanel id={`pane-${child.id}`} minSize="10%">
            <PaneTreeView
              node={child}
              tabVisible={tabVisible}
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
