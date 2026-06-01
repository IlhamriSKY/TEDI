import { type SortMode } from "./useFileTree";

export const SORT_MODES: ReadonlyArray<SortMode> = [
  "default",
  "name-asc",
  "name-desc",
  "modified-desc",
  "modified-asc",
];

export const SORT_LABELS: Record<SortMode, string> = {
  default: "Default (folders first)",
  "name-asc": "Name (A → Z)",
  "name-desc": "Name (Z → A)",
  "modified-desc": "Modified (newest first)",
  "modified-asc": "Modified (oldest first)",
};
