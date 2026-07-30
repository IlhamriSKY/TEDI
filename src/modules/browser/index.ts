export { BrowserPane, type BrowserPaneHandle } from "./BrowserPane";
export { BrowserFavicon } from "./BrowserFavicon";
export { setPaneDragActive } from "./lib/overlaySuppress";
export {
  previewEmbedAct,
  browserEmbedClose,
  browserEmbedHide,
  previewEmbedReparent,
  previewEmbedNavigate,
  previewEmbedDispatch,
  previewEmbedRead,
  previewEmbedConsole,
  previewEmbedScreenshot,
  previewEmbedSetBg,
  focusBrowserAddressBar,
  BROWSER_NAV_EVENT,
  BROWSER_FOCUS_ADDRESS_EVENT,
  type BrowserNavEvent,
  type BrowserDiag,
} from "./lib/native";
