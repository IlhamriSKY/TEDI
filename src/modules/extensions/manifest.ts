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

const SlashCommandSchema = z
  .object({
    name: z.string().min(1),
    label: z.string().min(1),
    description: z.string().optional(),
    /** Prompt template. `{{selection}}` and `{{cwd}}` are resolved by the host. */
    template: z.string().min(1).optional(),
  })
  .strict();

const ThemeSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    type: z.enum(["light", "dark"]),
    /** CSS variable name (without `--` prefix) to value. Applied via an
     *  injected `:root[data-ext-theme="<id>"]` stylesheet. */
    tokens: z.record(z.string(), z.string()),
  })
  .strict();

const EditorThemeSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    /** Path to a CSS file inside the extension. Loaded via `ext_read_asset`. */
    css: z.string().min(1),
  })
  .strict();

const PanelSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    // `right` is the slide-out slot next to the workspace, mutually
    // exclusive with the AI sidebar. The other surfaces are reserved.
    surface: z.enum(["sidebar-bottom", "statusbar-right", "right"]),
    icon: z.string().optional(),
    /** Open this panel once per session on launch. User can override. */
    defaultOpen: z.boolean().optional(),
    /** Command id (also in `contributes.commands`) that toggles this panel.
     *  Surfaces as a `<Kbd>` chip on the toggle button. */
    toggleCommand: z.string().optional(),
    /** Hide the host's title + close-X strip; the extension paints the whole
     *  panel and must provide its own close via `ctx.panel.close(panelId)`. */
    hideHostHeader: z.boolean().optional(),
  })
  .strict();

const AiToolSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    /** JSON Schema for the args. Loose in v1. */
    parameters: z.record(z.string(), z.unknown()),
    approval: z.enum(["auto", "needsApproval"]).default("auto"),
  })
  .strict();

const ContributesSchema = z
  .object({
    settings: z.array(SettingSchema).optional(),
    commands: z.array(CommandSchema).optional(),
    keybindings: z.array(KeybindingSchema).optional(),
    slashCommands: z.array(SlashCommandSchema).optional(),
    themes: z.array(ThemeSchema).optional(),
    editorThemes: z.array(EditorThemeSchema).optional(),
    panels: z.array(PanelSchema).optional(),
    aiTools: z.array(AiToolSchema).optional(),
  })
  .strict();

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
    contributes: z.preprocess(
      (v) => (v == null ? undefined : v),
      ContributesSchema.default({}),
    ),
    engines: EnginesSchema.nullish(),
  })
  .strict();

export type Manifest = z.infer<typeof ManifestSchema>;
export type ContributedSetting = z.infer<typeof SettingSchema>;
export type ContributedCommand = z.infer<typeof CommandSchema>;
export type ContributedKeybinding = z.infer<typeof KeybindingSchema>;
export type ContributedSlashCommand = z.infer<typeof SlashCommandSchema>;
export type ContributedTheme = z.infer<typeof ThemeSchema>;
export type ContributedEditorTheme = z.infer<typeof EditorThemeSchema>;
export type ContributedPanel = z.infer<typeof PanelSchema>;
export type ContributedAiTool = z.infer<typeof AiToolSchema>;

export function parseManifest(input: unknown): Manifest {
  return ManifestSchema.parse(input);
}

export function safeParseManifest(input: unknown):
  | { ok: true; manifest: Manifest }
  | { ok: false; error: string } {
  const result = ManifestSchema.safeParse(input);
  if (result.success) return { ok: true, manifest: result.data };
  const first = result.error.issues[0];
  const path = first?.path?.join(".") || "manifest";
  return { ok: false, error: `${path}: ${first?.message ?? "invalid"}` };
}
