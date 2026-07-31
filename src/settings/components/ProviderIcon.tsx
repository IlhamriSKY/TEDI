import type { ProviderId } from "@/modules/ai/config";
import { BrandIcon, type BrandName } from "@/components/BrandIcon";
import { Cpu, Globe, Monitor, Route, Server, Zap, type LucideIcon } from "lucide-react";

// Brand providers render inline logo marks; the rest map to stroke-based
// Lucide glyphs. The brand keys equal their provider ids.
const BRAND_PROVIDERS = new Set<ProviderId>(["openai", "anthropic", "google", "xai", "deepseek"]);

const LUCIDE_BY_PROVIDER: Partial<Record<ProviderId, LucideIcon>> = {
  cerebras: Cpu,
  groq: Zap,
  sumopod: Server,
  agentrouter: Route,
  "openai-compatible": Globe,
  lmstudio: Monitor,
};

type Props = {
  provider: ProviderId;
  size?: number;
  className?: string;
};

export function ProviderIcon({ provider, size = 14, className }: Props) {
  if (BRAND_PROVIDERS.has(provider)) {
    return <BrandIcon brand={provider as BrandName} size={size} className={className} />;
  }
  const Icon = LUCIDE_BY_PROVIDER[provider] ?? Globe;
  return <Icon size={size} strokeWidth={1.75} className={className} />;
}
