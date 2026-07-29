/**
 * Logo for an AI CLI agent in the `+` -> Agent submenu and the Settings card.
 *
 * Built-ins map to their vendor mark in {@link BrandIcon} where one exists.
 * opencode and Pi have no vendor glyph in that set, so they get a literal
 * stand-in rather than an invented logo: a terminal square and the `π` glyph
 * the tool is named for. User-defined agents get the generic bot.
 */
import { BrandIcon, type BrandName } from "./BrandIcon";
import { Bot, Pi, SquareTerminal } from "lucide-react";

/** Built-in agent id -> vendor mark. Ids are `AiCliKind` values. */
const BRAND: Record<string, BrandName> = {
  claude: "anthropic",
  codex: "openai",
  gemini: "google",
  grok: "xai",
  copilot: "github",
};

type Props = { agentId: string; size?: number; className?: string };

export function CliAgentIcon({ agentId, size = 14, className }: Props) {
  const brand = BRAND[agentId];
  if (brand) return <BrandIcon brand={brand} size={size} className={className} />;
  if (agentId === "opencode")
    return <SquareTerminal size={size} strokeWidth={1.75} className={className} />;
  if (agentId === "pi") return <Pi size={size} strokeWidth={1.75} className={className} />;
  return <Bot size={size} strokeWidth={1.75} className={className} />;
}
