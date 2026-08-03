import { z } from "zod";

/**
 * Manifest schema (TS/Zod side). Mirrors the Rust struct in
 * `src-tauri/src/modules/extensions/manifest.rs`. Rust validates at install
 * time; this schema narrows the type after `ext_list`/`ext_read_manifest`
 * and validates the `contributes.*` shape Rust treats as opaque.
 * To add a contribution category, extend `ContributesSchema` and update
 * `host.ts`. Keep IDs kebab-case.
 *
 * INVARIANT: this schema must never be stricter than Rust. Rust decides what
 * installs; this decides what renders. A field Rust accepts and this rejects
 * produces a GHOST: the install succeeds with a success toast, then `listInstalled`
 * drops the entry, so the extension never appears in Settings, never activates,
 * and cannot be uninstalled from the UI. Every object schema here is therefore
 * `.passthrough()`, and unknown keys are ignored by the runtime rather than
 * rejected. Loosening this side is the fix for any such divergence, never
 * tightening Rust.
 */

// Rust is the version authority (it parses and compares at install time) and
// `semver.ts` tolerates non-semver, so a regex here only ever ghosts an
// extension Rust was happy to install.
const SemverIshSchema = z.string().min(1);

const SettingSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(["string", "number", "boolean", "select", "note"]),
    label: z.string().min(1),
    description: z.string().optional(),
    default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
    section: z.string().optional(),
    secret: z.boolean().optional(),
  })
  .passthrough();

const CommandSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    category: z.string().optional(),
  })
  .passthrough();

const KeybindingSchema = z
  .object({
    command: z.string().min(1),
    key: z.string().min(1),
    when: z.string().optional(),
  })
  .passthrough();

// This schema is the reason the module-level INVARIANT above exists: it is the
// case where the strictness bug already shipped. v0.2.20 added `compact`, and
// the then-strict schema in v0.2.15..v0.2.19 rejected install of any extension
// that set it, with `contributes.panels.0: Invalid input`. The fix was to stop
// rejecting unknown keys here; the same reasoning was later applied to every
// other schema in this file. `engines.tedi` still gates hard when an extension
// genuinely needs the newer behaviour to work at all.
const PanelSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    // `right` is the slide-out slot next to the workspace, mutually
    // exclusive with the AI sidebar. `tab` mounts the panel renderer as
    // a full workspace tab (open via `ctx.tabs.openExtensionTab`), no
    // auto-rendered status-bar toggle. The other surfaces are reserved.
    surface: z.enum(["sidebar-bottom", "statusbar-right", "right", "tab"]),
    icon: z.string().optional(),
    /** Open this panel once per session on launch. User can override. */
    defaultOpen: z.boolean().optional(),
    /** Command id (also in `contributes.commands`) that toggles this panel.
     *  Surfaces as a `<Kbd>` chip on the toggle button. */
    toggleCommand: z.string().optional(),
    /** Hide the host's title + close-X strip; the extension paints the whole
     *  panel and must provide its own close via `ctx.panel.close(panelId)`. */
    hideHostHeader: z.boolean().optional(),
    /** Clusters this panel's status-bar toggle with the borderless extension
     *  status icons at the left of the right group (instead of next to the
     *  AI / SCM toggles). Chrome is identical either way — every right-panel
     *  toggle is icon-only — so this only affects ordering/placement. */
    compact: z.boolean().optional(),
    /**
     * What the status-bar button actually does. `"panel"` (the default) opens
     * the right-slot panel. `"action"` runs `toggleCommand` and never opens
     * anything - for a button that just does a thing (Screenshot captures the
     * window). The bar groups the two apart, and an action-kind button no
     * longer has to intercept its own click to stop a panel from sliding out.
     */
    kind: z.enum(["panel", "action"]).optional(),
  })
  .passthrough();

const AiToolSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    /** JSON Schema for the args. Loose in v1. */
    parameters: z.record(z.string(), z.unknown()),
    approval: z.enum(["auto", "needsApproval"]).default("auto"),
  })
  .passthrough();

// `.passthrough()` so a newer TEDI's manifest with an unknown contribution
// category (e.g. a future `contributes.notifications`) does not fail the
// whole install on older TEDI builds. The host only iterates the
// categories it knows about; extra categories sit in the parsed object
// untouched and inert.
const ContributesSchema = z
  .object({
    settings: z.array(SettingSchema).optional(),
    commands: z.array(CommandSchema).optional(),
    keybindings: z.array(KeybindingSchema).optional(),
    panels: z.array(PanelSchema).optional(),
    aiTools: z.array(AiToolSchema).optional(),
  })
  .passthrough();

const EnginesSchema = z
  .object({
    tedi: z.string().optional(),
  })
  .passthrough();

export const ManifestSchema = z
  .object({
    id: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9\-_.]*[a-z0-9]$/, "id must be lowercase kebab/dotted"),
    name: z.string().min(1),
    version: SemverIshSchema,
    // `.nullish()` accepts `null` and `undefined`. Rust serializes
    // `Option::None` as JSON `null`, which `.optional()` would reject.
    description: z.string().nullish(),
    author: z.string().nullish(),
    homepage: z.string().nullish(),
    icon: z.string().nullish(),
    main: z.string().nullish(),
    permissions: z.array(z.string()).default([]),
    // Rust emits JSON `null` when `contributes` is omitted. `.default({})`
    // only fires on `undefined`, so coerce `null` to `undefined` first.
    contributes: z.preprocess((v) => (v == null ? undefined : v), ContributesSchema.default({})),
    engines: EnginesSchema.nullish(),
  })
  .passthrough();

export type Manifest = z.infer<typeof ManifestSchema>;
export type ContributedSetting = z.infer<typeof SettingSchema>;
export type ContributedCommand = z.infer<typeof CommandSchema>;
export type ContributedKeybinding = z.infer<typeof KeybindingSchema>;
export type ContributedPanel = z.infer<typeof PanelSchema>;
export type ContributedAiTool = z.infer<typeof AiToolSchema>;

export function safeParseManifest(
  input: unknown,
): { ok: true; manifest: Manifest } | { ok: false; error: string } {
  const result = ManifestSchema.safeParse(input);
  if (result.success) return { ok: true, manifest: result.data };
  const first = result.error.issues[0];
  const path = first?.path?.join(".") || "manifest";
  return { ok: false, error: `${path}: ${first?.message ?? "invalid"}` };
}
