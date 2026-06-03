import { type EditorPaneHandle } from "@/modules/editor";
import { setEditorBridge } from "@/modules/extensions/editorBridge";
import { activeLeaf, type PaneTab } from "@/modules/tabs";
import { type PaneLeaf } from "@/modules/terminal";
import { useEffect, useRef } from "react";

type Params = {
  activeEditorHandle: EditorPaneHandle | null;
  activePaneTab: PaneTab | null;
};

/**
 * Wires `ctx.editor.{getActive,setActiveContent}` to the active editor pane.
 * The bridge closures read live state on each call (via the mutable ref) so an
 * extension that hangs onto `ctx.editor` always reaches the currently-focused
 * leaf, not whichever editor happened to be active when the extension
 * activated. Moved verbatim from App; the registration effect runs once.
 */
export function useEditorBridge({ activeEditorHandle, activePaneTab }: Params): void {
  const editorBridgeStateRef = useRef<{
    handle: EditorPaneHandle | null;
    leaf: PaneLeaf | null;
  }>({ handle: null, leaf: null });
  editorBridgeStateRef.current = {
    handle: activeEditorHandle,
    leaf: activePaneTab ? activeLeaf(activePaneTab) : null,
  };
  useEffect(() => {
    setEditorBridge({
      getActive() {
        const { handle, leaf } = editorBridgeStateRef.current;
        if (!handle || !leaf || leaf.leafKind !== "editor") return null;
        const content = handle.getContent();
        if (content === null) return null;
        const dirty = (leaf as PaneLeaf & { dirty?: boolean }).dirty === true;
        return { path: leaf.path, content, dirty };
      },
      setActiveContent(content) {
        const { handle, leaf } = editorBridgeStateRef.current;
        if (!handle || !leaf || leaf.leafKind !== "editor") return false;
        return handle.setContent(content);
      },
    });
    return () => setEditorBridge(null);
  }, []);
}
