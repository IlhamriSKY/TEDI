import { Streamdown } from "streamdown";
import { FloatTableProvider, markdownComponents } from "@/components/ai-elements/markdown-code";
import { safeUrlTransform } from "@/lib/markdownSafety";

/** A markdown table popped out into a float window. Re-renders the table markdown
 *  through the shared pipeline so it looks identical to the inline table;
 *  `FloatTableProvider` hides the (now-redundant) open-in-pane control. The
 *  TooltipProvider its controls need is supplied once by FloatApp for all kinds. */
export function FloatTableView({ markdown }: { markdown: string }) {
  return (
    <FloatTableProvider value={true}>
      <div className="h-full overflow-auto p-2">
        <Streamdown
          components={markdownComponents}
          controls={{ table: false }}
          urlTransform={safeUrlTransform}
        >
          {markdown}
        </Streamdown>
      </div>
    </FloatTableProvider>
  );
}
