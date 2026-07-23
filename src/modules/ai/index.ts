export { AgentRunBridge } from "./components/AgentRunBridge";
export { AgentStatusPill } from "./components/AgentStatusPill";
// AiInputBar (the composer) and AiSidebarPanel are loaded lazily (AiMiniWindow's
// own dynamic import / app/components/lazyPanels.ts). Re-exporting either from
// this barrel puts it back in the eager static graph (Rollup
// INEFFECTIVE_DYNAMIC_IMPORT: a module both statically re-exported here AND
// dynamically imported elsewhere stays eager), defeating the code-split and
// dragging the composer's markdown renderer (streamdown) onto first paint. No
// one imports them from this barrel, so drop the edge and let the lazy chunks
// hold them.
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
