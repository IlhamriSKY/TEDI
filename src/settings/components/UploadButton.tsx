import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FolderUploadIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentProps } from "react";

type Props = ComponentProps<typeof Button> & {
  /** Override the leading glyph. Defaults to the upload-folder icon. */
  icon?: typeof FolderUploadIcon;
};

/**
 * The canonical "upload / import / pick a file" button for Settings. Single
 * source of truth so every file-upload affordance stays visually identical -
 * the `.tedi` theme Import button is the reference. Pass the label as children;
 * forwards every Button prop (`onClick`, `disabled`, …). Add `className` to
 * extend, never to change the height/variant.
 */
export function UploadButton({ icon = FolderUploadIcon, className, children, ...props }: Props) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn("h-8 px-2 text-[11px]", className)}
      {...props}
    >
      <HugeiconsIcon icon={icon} size={12} strokeWidth={1.75} />
      {children}
    </Button>
  );
}
