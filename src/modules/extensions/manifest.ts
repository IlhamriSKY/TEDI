import { z } from "zod";

import { KNOWN_PERMISSIONS, PERMISSION_DESCRIPTIONS } from "./permissions";

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

/**
 * A permission string. Accepts ANY string - the enum branch exists purely so
 * `z.toJSONSchema` emits `anyOf: [{enum: [...]}, {type: "string"}]`, which is
 * the JSON-Schema idiom for "suggest these, accept anything". That gives an
 * author dropdown completion for the fixed permissions inside `manifest.json`
 * while still installing an extension that asks for `invoke:my_command` or a
 * permission a newer TEDI added. Widening only; see the INVARIANT above.
 */
const PermissionSchema = z.union([
  z.enum(KNOWN_PERMISSIONS).meta({
    description: Object.entries(PERMISSION_DESCRIPTIONS)
      .map(([id, why]) => `${id} - ${why}`)
      .join("\n"),
  }),
  z.string().meta({
    description:
      "Any other permission. `invoke:<command>` grants one Rust command (globs allowed, e.g. `invoke:git_*`, but an exact id is what the install dialog rewards).",
  }),
]);

const SettingSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .meta({ description: "Key passed to `ctx.settings.get(id)` / `.set(id, value)`." }),
    type: z.enum(["string", "number", "boolean", "select", "note"]).meta({
      description:
        "Control to render. `note` is read-only explanatory text; `select` requires `options`.",
    }),
    label: z.string().min(1).meta({ description: "Row label on the Settings card." }),
    description: z.string().optional().meta({ description: "Helper text under the label." }),
    default: z
      .union([z.string(), z.number(), z.boolean(), z.null()])
      .optional()
      .meta({ description: "Value used until the user changes it." }),
    options: z
      .array(z.object({ value: z.string(), label: z.string() }))
      .optional()
      .meta({ description: 'Choices for `type: "select"`.' }),
    section: z.string().optional().meta({ description: "Parsed but not currently used." }),
    secret: z.boolean().optional().meta({
      description: "Store this value in the OS keychain instead of the settings store.",
    }),
  })
  .passthrough();

const CommandSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .meta({
        description:
          "Command id, namespaced under your extension id so it cannot collide. Bind it with `ctx.registerCommandHandler`.",
        examples: ["acme.hello.greet"],
      }),
    title: z.string().min(1).meta({ description: "Label shown in the Command Palette." }),
    category: z
      .string()
      .optional()
      .meta({ description: "Palette group heading, usually your extension's short name." }),
  })
  .passthrough();

const KeybindingSchema = z
  .object({
    command: z
      .string()
      .min(1)
      .meta({ description: "Id of a command from `contributes.commands`." }),
    key: z
      .string()
      .min(1)
      .meta({
        description:
          "Chord. `Mod` is Ctrl on Windows/Linux and Cmd on macOS. Combine with `Alt`, `Shift`, `Ctrl`.",
        examples: ["Mod+Alt+B"],
      }),
    when: z.string().optional().meta({ description: "Advisory in this version; not evaluated." }),
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
    id: z
      .string()
      .min(1)
      .meta({ description: "Panel id, passed to `ctx.registerPanelRenderer(id, fn)`." }),
    title: z.string().min(1).meta({ description: "Panel header text and tab label." }),
    // `right` is the slide-out slot next to the workspace, mutually
    // exclusive with the AI sidebar. `tab` mounts the panel renderer as
    // a full workspace tab (open via `ctx.tabs.openExtensionTab`), no
    // auto-rendered status-bar toggle. The other surfaces are reserved.
    surface: z.enum(["sidebar-bottom", "statusbar-right", "right", "tab"]).meta({
      description:
        "`right` is the slide-out slot beside the workspace, with an auto-rendered status-bar toggle. `tab` mounts the renderer as a full workspace tab or split pane, opened via `ctx.tabs.openExtensionTab` / `openExtensionPane`. `sidebar-bottom` and `statusbar-right` are reserved and currently inert.",
    }),
    icon: z
      .string()
      .optional()
      .meta({
        description: "`lucide:<Name>`, `ext-asset:<relPath>` from your package, or a `data:` URL.",
        examples: ["lucide:Database"],
      }),
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
    name: z.string().min(1).meta({
      description: "Tool name the model calls. Bind it with `ctx.registerAiToolHandler(name, fn)`.",
    }),
    description: z.string().min(1).meta({
      description:
        "What the tool does and when to use it. This text is injected into the model's context on EVERY turn and is shown to the user in the install review dialog, so keep it short, honest and free of instructions aimed at the user.",
    }),
    /** JSON Schema for the args. Loose in v1. */
    parameters: z.record(z.string(), z.unknown()).meta({
      description: "JSON Schema for the arguments object the model must produce.",
    }),
    approval: z.enum(["auto", "needsApproval"]).default("auto").meta({
      description:
        "Advisory only: the host forces approval on every extension tool regardless of this value.",
    }),
  })
  .passthrough();

// `.passthrough()` so a newer TEDI's manifest with an unknown contribution
// category (e.g. a future `contributes.notifications`) does not fail the
// whole install on older TEDI builds. The host only iterates the
// categories it knows about; extra categories sit in the parsed object
// untouched and inert.
const ContributesSchema = z
  .object({
    settings: z.array(SettingSchema).optional().meta({
      description:
        "Rows on this extension's Settings card. Read them back with `ctx.settings.get(id)`.",
    }),
    commands: z.array(CommandSchema).optional().meta({
      description:
        "Commands shown in the Command Palette. Bind each one with `ctx.registerCommandHandler(id, fn)` from `activate()`.",
    }),
    keybindings: z
      .array(KeybindingSchema)
      .optional()
      .meta({ description: "Default keyboard shortcuts for contributed commands." }),
    panels: z.array(PanelSchema).optional().meta({
      description:
        "Panel surfaces. Bind each one with `ctx.registerPanelRenderer(id, fn)`. Requires the `panels:register` permission.",
    }),
    aiTools: z.array(AiToolSchema).optional().meta({
      description:
        "Tools the AI agent can call. Prefer declaring these from `activate()` via `ctx.contribute.aiTools()` so a tool is never published without its handler.",
    }),
  })
  .passthrough()
  .meta({
    description:
      "Declarative contributions. These are seeded BEFORE `activate()` runs and survive an activate that throws, so the user can always reach the Settings card to disable or uninstall.",
  });

const EnginesSchema = z
  .object({
    tedi: z
      .string()
      .optional()
      .meta({
        description:
          "Minimum TEDI version this extension needs. Checked at install AND at activate, so an older host refuses rather than half-working. Name the version that ADDED the newest API you call; leave it off if you only use API from your first release.",
        examples: [">=0.4.25"],
      }),
  })
  .passthrough()
  .meta({ description: "Host-version constraints." });

export const ManifestSchema = z
  .object({
    id: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9\-_.]*[a-z0-9]$/, "id must be lowercase kebab/dotted")
      .meta({
        description:
          "Unique id, lowercase, 3-64 chars, letters/digits/dot/dash/underscore. Convention: <publisher>.<name>. Also the install folder name, so it can never contain a path separator.",
        examples: ["acme.hello"],
      }),
    name: z.string().min(1).meta({
      description: "Display name, shown in Settings, the install dialog and the registry.",
    }),
    version: SemverIshSchema.meta({
      description:
        "This release's version. Compared leniently (digits only), so `1.2.3` and `1.2.3-beta` rank equal. Bump it on every published release: the updater compares it against the upstream tag.",
      examples: ["0.1.0"],
    }),
    // `.nullish()` accepts `null` and `undefined`. Rust serializes
    // `Option::None` as JSON `null`, which `.optional()` would reject.
    description: z.string().nullish().meta({
      description: "One or two sentences, shown on the Settings card and in the install dialog.",
    }),
    author: z.string().nullish().meta({ description: "Author name, optionally with a URL." }),
    homepage: z
      .string()
      .nullish()
      .meta({ description: "Project or docs URL, linked from the Settings card." }),
    icon: z
      .string()
      .nullish()
      .meta({
        description:
          "Relative path to a PNG/SVG inside the package, used as the extension icon. 64x64 or larger.",
        examples: ["logo.png"],
      }),
    main: z
      .string()
      .nullish()
      .meta({
        description:
          "Relative path to the ES-module entry point exporting `activate(ctx)`. The host imports exactly this one file, so bundle your sources into it. Omit for a declarative-only pack (settings, no code).",
        examples: ["extension.js"],
      }),
    permissions: z.array(PermissionSchema).default([]).meta({
      description:
        "What the user is asked to approve at install time. Every gated `ctx.*` call checks this list, and it is FROZEN at install: an update that needs a new permission re-prompts, so ask for the narrowest set that works.",
    }),
    // Rust emits JSON `null` when `contributes` is omitted. `.default({})`
    // only fires on `undefined`, so coerce `null` to `undefined` first.
    contributes: z.preprocess((v) => (v == null ? undefined : v), ContributesSchema.default({})),
    engines: EnginesSchema.nullish(),
  })
  .passthrough()
  .meta({
    id: "TediExtensionManifest",
    title: "TEDI extension manifest",
    description:
      "manifest.json for a TEDI extension. Run `tedi ext validate` to check one, and `tedi ext types` to refresh the matching tedi.d.ts.",
  });

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
