/**
 * Default search engine for the browser address bar. When the user types
 * something that isn't a URL (e.g. "youtube"), the address bar runs it as a
 * query through the configured engine instead of failing to navigate.
 */
export type SearchEngineId =
  | "google"
  | "bing"
  | "duckduckgo"
  | "brave"
  | "yahoo"
  | "ecosia"
  | "startpage"
  | "qwant"
  | "yandex"
  | "baidu"
  | "perplexity";

export type SearchEngine = {
  id: SearchEngineId;
  label: string;
  /** Query URL template; `%s` is replaced with the URL-encoded search terms. */
  queryUrl: string;
};

export const SEARCH_ENGINES: SearchEngine[] = [
  { id: "google", label: "Google", queryUrl: "https://www.google.com/search?q=%s" },
  { id: "bing", label: "Bing", queryUrl: "https://www.bing.com/search?q=%s" },
  { id: "duckduckgo", label: "DuckDuckGo", queryUrl: "https://duckduckgo.com/?q=%s" },
  { id: "brave", label: "Brave", queryUrl: "https://search.brave.com/search?q=%s" },
  { id: "yahoo", label: "Yahoo", queryUrl: "https://search.yahoo.com/search?p=%s" },
  { id: "ecosia", label: "Ecosia", queryUrl: "https://www.ecosia.org/search?q=%s" },
  { id: "startpage", label: "Startpage", queryUrl: "https://www.startpage.com/sp/search?query=%s" },
  { id: "qwant", label: "Qwant", queryUrl: "https://www.qwant.com/?q=%s" },
  { id: "yandex", label: "Yandex", queryUrl: "https://yandex.com/search/?text=%s" },
  { id: "baidu", label: "Baidu", queryUrl: "https://www.baidu.com/s?wd=%s" },
  { id: "perplexity", label: "Perplexity", queryUrl: "https://www.perplexity.ai/search?q=%s" },
];

export const DEFAULT_SEARCH_ENGINE_ID: SearchEngineId = "google";

/** Resolve an engine by id, falling back to the default for unknown/missing ids. */
export function searchEngineById(id: string | undefined | null): SearchEngine {
  return SEARCH_ENGINES.find((e) => e.id === id) ?? SEARCH_ENGINES[0];
}

/** Build a search results URL for `query` using the configured engine. */
export function buildSearchUrl(engineId: string | undefined | null, query: string): string {
  return searchEngineById(engineId).queryUrl.replace("%s", encodeURIComponent(query));
}
