import { z } from "zod";

/**
 * Manifest schema (TS/Zod side). Mirrors the Rust struct in
 * `src-tauri/src/modules/extensions/manifest.rs`. Rust validates at install
 * time; this schema narrows the type after `ext_list`/`ext_read_manifest`
 * and validates the `contributes.*` shape Rust treats as opaque.
 * To add a contribution category, extend `ContributesSchema` and update
 * `host.ts`. Keep IDs kebab-case.
 */

const SemverIshSchema = z.string().regex(/^\d+\.\d+\.\d+([\-+].*)?$/);

const SettingSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(["string", "number", "boolean", "select"]),
    label: z.string().min(1),
    description: z.string().optional(),
    default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
    section: z.string().optional(),
    secret: z.boolean().optional(),
  })
  .strict();

const CommandSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    category: z.string().optional(),
  })
  .strict();

const KeybindingSchema = z
  .object({
    command: z.string().min(1),
    key: z.string().min(1),
    when: z.string().optional(),
  })
  .strict();

// `.passthrough()` (not `.strict()`): older TEDI builds must tolerate
// extension manifests that declare panel flags added in newer TEDI
// versions. v0.2.20 added `compact`, and a `.strict()` schema in
// v0.2.15..v0.2.19 rejected install of any extension that set it with
// `contributes.panels.0: Invalid input`. Unknown keys now survive the
// parse and are simply ignored by the runtime renderer; engines.tedi
// constraints from the extension manifest still gate hard if the
// extension needs the new behaviour to work at all.
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
    /** Render the auto-rendered status-bar toggle button as an icon-only
     *  square button (no `title` text, no `<Kbd>` chip). Requires `icon`
     *  to be set on this panel. `aria-label` keeps the title for a11y. */
    compact: z.boolean().optional(),
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
  .strict();

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
  .strict();

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
  .strict();

export type Manifest = z.infer<typeof ManifestSchema>;
export type ContributedSetting = z.infer<typeof SettingSchema>;
export type ContributedCommand = z.infer<typeof CommandSchema>;
export type ContributedKeybinding = z.infer<typeof KeybindingSchema>;
export type ContributedPanel = z.infer<typeof PanelSchema>;
export type ContributedAiTool = z.infer<typeof AiToolSchema>;

export function parseManifest(input: unknown): Manifest {
  return ManifestSchema.parse(input);
}

export function safeParseManifest(
  input: unknown,
): { ok: true; manifest: Manifest } | { ok: false; error: string } {
  const result = ManifestSchema.safeParse(input);
  if (result.success) return { ok: true, manifest: result.data };
  const first = result.error.issues[0];
  const path = first?.path?.join(".") || "manifest";
  return { ok: false, error: `${path}: ${first?.message ?? "invalid"}` };
}
