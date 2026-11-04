import { cn } from "@/lib/utils";

// Drawn by `.tedi-spinner` in globals.css. An HTML box, not an icon: Chromium can
// run this rotation on the compositor, and it cannot do that for an <svg>.
function Spinner({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn("tedi-spinner size-4", className)}
      {...props}
    />
  );
}

export { Spinner };
