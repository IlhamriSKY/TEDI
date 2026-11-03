import { Input } from "@/components/ui/input";
import { Search, X } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef } from "react";

type Props = {
  value: string;
  onChange: (value: string) => void;
  /** Escape. The panel's header toggle closes it the same way. */
  onClose: () => void;
  placeholder: string;
  /** Off for a box that is always there: it must not take focus at app start. */
  autoFocus?: boolean;
};

/** The box a panel's header search button opens under the header, as in Files. */
export function PanelSearchInput({
  value,
  onChange,
  onClose,
  placeholder,
  autoFocus = true,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);
  return (
    <motion.div
      className="relative shrink-0 px-2 py-1.5"
      initial={{ opacity: 0, transform: "translateY(-15px)" }}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
    >
      <Search
        size={13}
        strokeWidth={2}
        className="text-muted-foreground absolute top-1/2 left-4 -translate-y-1/2"
      />
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-7 pr-7 pl-6.5 text-xs"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive absolute top-1/2 right-3.5 -translate-y-1/2 cursor-pointer rounded p-0.5"
          aria-label="Clear search"
        >
          <X size={11} strokeWidth={2} />
        </button>
      ) : null}
    </motion.div>
  );
}
