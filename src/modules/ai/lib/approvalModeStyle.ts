import type { ApprovalMode } from "@/modules/settings/store";

/** Text-color token per approval mode. Used for the colored mode titles in the
 *  agent/approval dropdown. Amber = manual (Ask), blue = Semi, green = Full
 *  Auto - the same hues the textarea border uses so the cues line up. */
export const APPROVAL_MODE_TONE: Record<ApprovalMode, string> = {
  ask: "text-icon-working",
  semi: "text-info",
  yolo: "text-diff-added",
};

/** Filled-button tokens per approval mode for the composer Send button, so the
 *  active autonomy level reads from the one place the user looks before sending.
 *  `text-background` adapts per theme: the status hues are dark in the light
 *  theme and light in the dark theme, so the page background is always the
 *  contrasting foreground. Mirrors APPROVAL_MODE_TONE. */
export const APPROVAL_MODE_SEND: Record<ApprovalMode, string> = {
  ask: "bg-icon-working text-background hover:bg-icon-working/90",
  semi: "bg-info text-background hover:bg-info/90",
  yolo: "bg-diff-added text-background hover:bg-diff-added/90",
};
