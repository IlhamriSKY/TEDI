import { type useTabs } from "@/modules/tabs";

/**
 * The full return shape of `useTabs`. The app's domain hooks each `Pick` the
 * subset of tab actions they thread in, so their parameter types stay exactly
 * aligned with the live `useTabs` signatures (no hand-maintained duplicates
 * that could drift).
 */
export type TabsApi = ReturnType<typeof useTabs>;
