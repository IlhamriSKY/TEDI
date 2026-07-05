export { AgentRunBridge } from "./components/AgentRunBridge";
export { AgentStatusPill } from "./components/AgentStatusPill";
export { AiInputBar } from "./components/AiInputBar";
// AiSidebarPanel is loaded lazily via app/components/lazyPanels.ts; re-exporting
// it here put AiMiniWindow back in the eager static graph (Rollup
// INEFFECTIVE_DYNAMIC_IMPORT), defeating the code-split. No one imports it from
// this barrel, so drop the edge and let the lazy chunk hold it.
export { SelectionAskAi } from "./components/SelectionAskAi";
export {
  EMPTY_PROVIDER_KEYS,
  getAllKeys,
  getKey,
  setKey,
  clearKey,
  hasAnyKey,
  type ProviderKeys,
} from "./lib/keyring";
export {
  getActiveProviderKey,
  getOrCreateChat,
  hasKeyForModel,
  sendMessage,
  stop,
  useChatStore,
  type AgentMeta,
  type AgentRunStatus,
  type SessionUsage,
} from "./store/chatStore";
