import { Fragment } from "react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { EditorPane, type EditorPaneHandle } from "@/modules/editor";
import { TerminalPane, type TerminalPaneHandle } from "@/modules/terminal";
import type { SearchAddon } from "@xterm/addon-search";
import type { PaneNode } from "@/modules/terminal/lib/panes";
import type { TediOpenInput, TediSpawnTabInput } from "@/modules/terminal/lib/useTerminalSession";
import type { SshStatus } from "@/modules/ssh/status";

export type LeafBundle = {
  // terminal-only
  setTerminalRef: (h: TerminalPaneHandle | null) => void;
  onSearchReady: (addon: SearchAddon) => void;
  onCwd: (cwd: string) => void;
  onDetectedLocalUrl: (url: string) => void;
  onExit: (code: number) => void;
  onTediOpen: (input: TediOpenInput) => void;
  onTediSpawnTab: (input: TediSpawnTabInput) => void;
  onSshStatus: (status: SshStatus) => void;
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
  /** Set of editor-leaf ids currently rendered in markdown-preview mode. */
  mdPreviewLeafIds: ReadonlySet<number>;
};

export function PaneTreeView({
  node,
  tabVisible,
  activeLeafId,
  onFocusLeaf,
  getBundle,
  mdPreviewLeafIds,
}: Props) {
  if (node.kind === "leaf") {
    const focused = node.id === activeLeafId;
    const b = getBundle(node.id);
    const leafClass = cn(
      "relative h-full w-full overflow-hidden rounded-md border bg-background shadow-sm transition-colors",
      focused ? "border-primary/60 ring-1 ring-primary/30" : "border-border",
    );
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
          className={leafClass}
        >
          <div className="h-full w-full p-1.5">
            <TerminalPane
              leafId={node.id}
              visible={tabVisible}
              focused={focused}
              initialCwd={node.cwd}
              sshConnectionId={node.sshConnectionId}
              ref={b.setTerminalRef}
              onSearchReady={(_id, addon) => b.onSearchReady(addon)}
              onCwd={(_id, cwd) => b.onCwd(cwd)}
              onDetectedLocalUrl={(_id, url) => b.onDetectedLocalUrl(url)}
              onExit={(_id, code) => b.onExit(code)}
              onTediOpen={(_id, input) => b.onTediOpen(input)}
              onTediSpawnTab={(_id, input) => b.onTediSpawnTab(input)}
              onSshStatus={(_id, status) => b.onSshStatus(status)}
            />
          </div>
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
        className={leafClass}
      >
        <EditorPane
          ref={b.setEditorRef}
          path={node.path}
          onDirtyChange={b.onDirtyChange}
          onClose={b.onCloseLeaf}
          mdPreview={mdPreviewLeafIds.has(node.id)}
        />
      </div>
    );
  }

  return (
    <ResizablePanelGroup
      orientation={node.dir === "row" ? "horizontal" : "vertical"}
      className="gap-1.5"
    >
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 && (
            <ResizableHandle
              withHandle
              className="bg-border/50 hover:bg-primary/50 transition-colors"
            />
          )}
          <ResizablePanel id={`pane-${child.id}`} minSize="10%">
            <PaneTreeView
              node={child}
              tabVisible={tabVisible}
              activeLeafId={activeLeafId}
              onFocusLeaf={onFocusLeaf}
              getBundle={getBundle}
              mdPreviewLeafIds={mdPreviewLeafIds}
            />
          </ResizablePanel>
        </Fragment>
      ))}
    </ResizablePanelGroup>
  );
}
