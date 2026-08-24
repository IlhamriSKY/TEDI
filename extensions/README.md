# TEDI Extensions: Author Guide

This is the complete developer guide for building TEDI extensions. It is the
reference third-party developers use to publish extensions worldwide.

## 1. Philosophy

TEDI extensions are **runtime-installed, plug-and-play JavaScript packages**.
A few facts shape everything else in this guide:

- **The release binary ships no extensions.** Nothing is baked into the
  installer. Every extension is installed by the user at runtime.
- **No build step, no recompile.** Install / enable / disable / uninstall all
  happen live. The runtime loads your `main` JS via a Blob-URL dynamic import,
  so a fresh module instance is minted on each activation.
- **Two zero-config sources.** A local `.zip` or a GitHub `owner/repo` slug.
  Re-installing the same `manifest.id` replaces the copy on disk and reloads.
- **Declarative + imperative.** A manifest declares _what_ you contribute
  (settings, commands, panels, …); an optional `extension.js` wires up _runtime
  behavior_ through a host-provided `ctx` object.
- **Install-time review is the trust boundary.** Extensions run JavaScript
  inside the app with full privileges. The permission gate on `ctx.*` is an
  advisory convenience, not a sandbox. See [Section 9](#9-security-model), read
  it before you ship, and especially before you install someone else's
  extension.

| Source       | UI tab in _Settings -> Extensions_ | Backend command           |
| ------------ | ---------------------------------- | ------------------------- |
| Local `.zip` | **From file**                      | `ext_install_from_zip`    |
| GitHub repo  | **From GitHub**                    | `ext_install_from_github` |

A public registry browser is also available from the CLI
(`tedi ext list`, registry at <https://tedi.ilhamriski.com/extensions/>); see
[Section 8](#8-install--update--packaging).

### Reference extensions

These ship as standalone repos and exercise nearly every capability. When in
doubt, copy the one closest to what you are building.

| Extension                 | Install string                          | Demonstrates                                                                                                                                                                                                                                      |
| ------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Beautify**              | `IlhamriSKY/TEDI.beautify`              | `headerbar:write` with `placement:"left"`, `editor:read`/`editor:write` live-buffer round-trip, native sidecar via `shell_bg_spawn_direct` + `READY {port,token}` handshake, multi-language formatting in a Rust binary.                          |
| **Discord Rich Presence** | `IlhamriSKY/TEDI.discord-rich-presence` | `app.onContextChange`, `statusbar:write`, permission-gated `invoke`, idempotent `deactivate`, native sidecar binary.                                                                                                                              |
| **SQL Explorer**          | `IlhamriSKY/TEDI.sql-explorer`          | `panels[]` with `surface:"tab"` + `tabs:open`, `headerbar:write`, `settings:*`, `secrets:*`, sidecar HTTP server, `ctx.ui.codeEditor` (SQL).                                                                                                      |
| **Secondary Folder Tree** | `IlhamriSKY/TEDI.secondary-folder-tree` | `panels[]` `surface:"right"`, `commands` + `keybindings`, `ctx.registerCommandHandler`, `ctx.panel.toggle`, `ctx.ui.mountFolderTree`.                                                                                                             |
| **API Client**            | `IlhamriSKY/TEDI.api-client`            | `invoke:http_stream` / `invoke:http_abort` as the entire backend (no sidecar), two `ctx.sidebar` sections at once, `ctx.storage` for bulk data with `ctx.secrets` for the values that must not hit disk, `ctx.ui.codeEditor` (JSON + JavaScript). |
| **Screenshot**            | `IlhamriSKY/TEDI.screenshot`            | `panels[]` used only to mint a status-bar toggle, then a capture-phase click interception, native sidecar.                                                                                                                                        |
| **RTK Bridge**            | `IlhamriSKY/TEDI.rtk-bridge`            | `shell:transform` rewriting every AI shell command (RTK pattern).                                                                                                                                                                                 |

---

## 2. Quick start

### Scaffold one (recommended)

```bash
tedi ext create acme.hello
cd acme.hello
npm install        # esbuild + the type checker
npm run watch      # src/ -> extension.js on every save
```

That writes a working extension with the typed API already wired up:

| File                   | Why it is there                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `manifest.json`        | Points `$schema` at the file below, so your editor completes and validates it.     |
| `manifest.schema.json` | JSON Schema for the manifest, generated from the same schema the host parses with. |
| `tedi.d.ts`            | The typed `ctx` API. Standalone, no dependencies.                                  |
| `jsconfig.json`        | Turns `tedi.d.ts` on for plain JavaScript (`checkJs`).                             |
| `src/index.js`         | `activate(ctx)` / `deactivate()`, with the JSDoc that binds `ctx` to its type.     |
| `build.mjs`            | esbuild config. Reads `manifest.main`, so it needs no editing.                     |
| `package.json`         | `build` / `watch` / `check` scripts.                                               |

Both `tedi.d.ts` and `manifest.schema.json` are written **from the TEDI binary
you ran the command with**, so they describe the host you are testing against.
After upgrading TEDI, run `tedi ext types` in the folder to refresh them.

Before publishing, run `tedi ext validate` (see
[Packaging](#packaging)). It catches the mistakes that are otherwise invisible
at runtime: a keybinding pointing at a command id that does not exist, a
misspelled permission, a missing `main` file.

### Or by hand

A complete hello-world extension is two files.

`manifest.json`:

```json
{
  "id": "acme.hello",
  "name": "Hello",
  "version": "1.0.0",
  "description": "Says hello from the status bar.",
  "author": "Me",
  "main": "extension.js",
  "permissions": ["ui:toast", "statusbar:write"],
  "engines": { "tedi": ">=0.3.9" }
}
```

`extension.js` (an ES module):

```js
export async function activate(ctx) {
  ctx.logger.info("activating");

  ctx.statusBar.setItem({
    id: "hello",
    icon: "lucide:Sun", // Lucide icon name; see ctx.ui.icon
    tooltip: "Say hello",
    tone: "success",
  });

  // Wire a command + keybinding declared in the manifest, or just call a
  // facade directly. Here we react to app-state changes:
  const off = ctx.app.onContextChange((snap) => {
    ctx.logger.info("workspace:", snap.workspaceCwd);
  });
  ctx.addDisposer(off); // optional; onContextChange already auto-disposes

  ctx.ui.toast("Hello from acme.hello", { variant: "success" });
}

export async function deactivate() {
  // Optional. Tear down anything the host can't see (timers, sockets).
  // ctx.statusBar items, onContextChange, etc. are auto-removed for you.
}
```

Zip both files at the archive root, install via _Settings -> Extensions ->
From file_, review the permission dialog, click **Install**. That is the whole
loop.

### Types, without TypeScript

`tedi.d.ts` is the typed contract for `ctx`. It is one standalone file with no
imports and no dependencies, so plain JavaScript gets full completion and real
diagnostics from it:

```js
/** @param {import("./tedi").ExtensionContext} ctx */
export async function activate(ctx) {
  ctx.ui.tost("hi");
  //     ~~~~ Property 'tost' does not exist. Did you mean 'toast'?
}
```

This matters more than it looks. An extension's mistakes usually surface inside
an async click handler, where a `TypeError` becomes an unhandled rejection: the
button still looks fine, nothing appears, and there is no stack unless DevTools
happened to be open. The checker moves that to the editor.

Bring it into an existing extension with:

```bash
tedi ext types          # writes tedi.d.ts + manifest.schema.json here
```

then add a `jsconfig.json` with `"checkJs": true` and annotate wherever you keep
`ctx`:

```js
/** @type {import("../tedi").ExtensionContext | null} */
let ctx = null;
```

TypeScript extensions import the same file directly:

```ts
import type { ExtensionContext } from "./tedi";
```

### Local development (no zip, no publish)

Iterating through "zip → install → test" for every change is slow. When you
develop TEDI itself, keep your extension working copy under the repo's
`extensions/<id>/` folder and run:

```bash
pnpm tauri:dev:ext      # link every extensions/<id> into the dev app, then run dev
```

This runs [`scripts/link-dev-extensions.mjs`](../scripts/link-dev-extensions.mjs),
which creates a **directory junction (Windows) / symlink (Unix)** from the dev
build's app-data extensions folder (`<appData>/id.ilhamrisky.tedi.dev/extensions/<id>`)
to your repo working copy, no copying. `ext_list` follows the link and, with no
`state.json` entry, loads the extension **enabled with all its manifest
permissions auto-approved**; `extension.js`, assets, and `ctx.installPath`
resolve through the link. Edit `extension.js` (or run `npm run watch` and edit `src/`, see
[Build pipeline](#build-pipeline-src--extensionjs)) and the host reloads the
extension on its own, see [Hot reload](#hot-reload). Ctrl+R still works if you
ever want to reset everything at once.

| Command              | What it does                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `pnpm tauri:dev:ext` | Link all repo extensions, then `pnpm tauri:dev`.                                           |
| `pnpm link:ext`      | Just create the links (add `tedi.sql-explorer …` to limit to ids; or `TEDI_DEV_EXT_IDS=`). |
| `pnpm relink:ext`    | `--force`: replace a previously **installed** dev copy with the live link.                 |
| `pnpm unlink:ext`    | Remove the dev links (never touches your repo source).                                     |

The links live only in the **dev** profile (`…tedi.dev`), so they never affect a
real install. If an id was previously installed into the dev build, `link:ext`
skips it to avoid clobbering, run `pnpm relink:ext` to switch it to the repo
link.

### Build pipeline (src/ → extension.js)

A hello-world extension is a single hand-written `extension.js`. Past a few
hundred lines that file turns into a "god file" nobody wants to read, so every
**official** TEDI extension keeps its source split into small `src/` modules and
bundles them into one `extension.js` with [esbuild](https://esbuild.github.io/).
The convention (use any official extension as a template):

```
<id>/
├── src/                 hand-written modules, none over ~300 lines
│   ├── index.js         entry: exports activate(ctx) / deactivate()
│   ├── runtime.js       shared state singletons + constants + setters
│   └── …                one cohesive concern per file
├── manifest.json        "$schema": "./manifest.schema.json" on the first line
├── manifest.schema.json from `tedi ext types`
├── tedi.d.ts            from `tedi ext types`
├── jsconfig.json        "checkJs": true, so tedi.d.ts actually bites
├── build.mjs            esbuild config, identical in every extension
├── package.json         "build": "node build.mjs"
├── .gitignore           ignores /extension.js and node_modules/
└── extension.js         GENERATED, never committed
```

`build.mjs` reads the entry point, the output path and the banner from
`manifest.json`, so it carries nothing extension-specific and can be copied
between extensions without edits. Every bundled TEDI extension runs a
byte-identical copy.

```bash
npm install        # once
npm run build      # src/ → extension.js (single ESM bundle)
```

Key rules that keep the fleet consistent:

- **`extension.js` is a build artifact, not source.** It is git-ignored and
  rebuilt in CI, so the repo only ever holds readable `src/` modules.
- **Bundle, don't ship `src/`.** The host imports exactly one `manifest.main`
  file; esbuild inlines every `src/` import into it (`bundle: true`,
  `format: "esm"`). `activate` / `deactivate` stay exported from the bundle.
- **No host-side build.** TEDI loads `extension.js` verbatim: there is no
  transpile step at install or runtime, so the bundle must be plain ES2022.
- **Share mutable state via setters.** Put singletons + `setX()` writers in one
  `runtime.js`; other modules import the live bindings (esbuild preserves ESM
  live-binding semantics across the bundle) instead of duplicating state.
- **Type the `ctx` singleton.** One JSDoc line on the declaration turns on
  checking for every `ctx.*` call in the bundle:

  ```js
  /** @type {import("../tedi").ExtensionContext | null} */
  export let ctx = null;
  ```

  `npm run typecheck` then reports a misspelled member or a wrong argument
  before you ever load the extension.

CI builds the same bundle into the release zip, see
[Packaging](#packaging) and [Releasing via CI](#releasing-via-ci) below.

### How `activate` / `deactivate` are resolved

```js
// The host imports your module and picks, in order:
//   activate   = mod.activate   ?? mod.default?.activate
//   deactivate = mod.deactivate ?? mod.default?.deactivate
```

- `activate(ctx)` is awaited. Its **return value is ignored.** Throwing fails
  activation; the host revokes the script, runs disposers, and re-seeds your
  declarative contributions so your settings card still renders.
- `deactivate()` is **optional**, awaited before disposers run, and may be
  called multiple times in a session, keep it idempotent.
- A `main` file with **no** `activate` export logs a warning but keeps your
  declarative contributions.
- Omit `main` entirely for a **pure-declarative pack** (settings only).

---

## 3. Package layout & manifest schema

### Package layout

```
<id>/
├── manifest.json        required, at the archive root
├── extension.js         optional ES module exporting activate(ctx) / deactivate()
│                        (hand-written, OR generated from src/, see Build pipeline)
├── logo.png             optional icon shown on the Settings -> Extensions card
├── assets/              optional images, css, ...
└── sidecar/             optional native binaries (made executable on install)
```

Only the **built** artifacts above ship in the zip. Larger extensions keep their
source in `src/` and generate `extension.js` with a bundler, that generated file
is git-ignored and rebuilt in CI, never committed. See
[Build pipeline](#build-pipeline-src--extensionjs).

`<id>` equals `manifest.id` and becomes the on-disk folder name. The installer
auto-unwraps a single-root archive (e.g. a GitHub source zip `repo-<sha>/…`)
when every entry shares one top-level segment **and** that segment contains a
`manifest.json`. A `manifest.json` at the archive root means no unwrap.

### `manifest.json` fields

The schema is validated by Zod on the frontend (`manifest.ts`) and mirrored in
Rust (`manifest.rs`). **Every object in the manifest tolerates unknown keys**,
top level included. That is a deliberate invariant, not an oversight: Rust
decides what installs and the Zod schema only decides what renders, so a key
Rust accepts and Zod rejects produces a _ghost_ - the install reports success,
then the entry vanishes from Settings, never activates, and cannot be
uninstalled from the UI. It shipped once, in v0.2.15..v0.2.19, when
`contributes.panels[].compact` was added.

Two consequences worth relying on:

- A manifest written for a newer TEDI still installs on an older one. The host
  iterates only the keys it knows; the rest sit inert.
- `"$schema": "./manifest.schema.json"` is just such a key. Put it on the first
  line and your editor gives you completion, hover docs and inline validation
  while you write the file. `tedi ext create` and `tedi ext types` write that
  schema next to your manifest, generated from the very schema the host parses
  with.

| Field         | Required | Type / rules                                                                                                                                                                                                                                                            |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | yes      | `string`, 3–64 chars, regex `^[a-z0-9][a-z0-9\-_.]*[a-z0-9]$` (lowercase kebab/dotted), no leading/trailing dot. Re-validated on every install/read/enable/disable/uninstall to block path traversal. Use a `<publisher>.<feature>` prefix, e.g. `acme.my-integration`. |
| `name`        | yes      | `string`, non-empty (whitespace-only rejected).                                                                                                                                                                                                                         |
| `version`     | yes      | `string`, non-empty. Compared leniently (digit runs only), so `1.2.3` and `1.2.3-beta` rank equal. Neither side enforces a semver shape: a regex here would only ghost an extension Rust was happy to install.                                                          |
| `description` | no       | `string` or `null`.                                                                                                                                                                                                                                                     |
| `author`      | no       | `string` or `null`.                                                                                                                                                                                                                                                     |
| `homepage`    | no       | `string` or `null` (not URL-validated).                                                                                                                                                                                                                                 |
| `icon`        | no       | `string` path inside the package. Read and base64'd for the install dialog; missing icon is non-fatal (falls back to a letter avatar). 5 MiB cap when read live.                                                                                                        |
| `main`        | no       | `string` JS entry path relative to the root. Omit for declarative-only packs. If present it must resolve inside the root and exist, or install fails.                                                                                                                   |
| `permissions` | no       | `string[]`, defaults to `[]`. Glob-style kebab strings (see [Section 6](#6-permissions-reference)). Recorded verbatim at install; any string is accepted, so a typo grants nothing rather than failing the install. `tedi ext validate` catches one.                    |
| `contributes` | no       | `object`, defaults to `{}`. Unknown contribution categories are tolerated and ignored (`passthrough`).                                                                                                                                                                  |
| `engines`     | no       | `object` with an optional `tedi: string` constraint. Checked at install AND at activation.                                                                                                                                                                              |

#### `engines.tedi` constraint grammar

Empty or `*` always passes. Recognized prefixes (checked in order): `>=`, `<=`,
`>`, `<`, `=`; a bare `X.Y.Z` means exact (`=`). A leading `v`/`V` is stripped.
Comparison splits on non-digit runs and compares numerically, so prerelease /
build suffixes after `x.y.z` are effectively ignored. The constraint is enforced
**twice**: at install (Rust refuses, deletes the staged copy, errors
`<name> requires TEDI <req>, but this host is <host>`) and at activation (the
loader toasts a warning and skips `activate`).

```json
"engines": { "tedi": ">=0.3.9" }
```

### `contributes.*` reference

Each contribution array is independently parsed, and every per-item schema
tolerates unknown keys, for the reason given above: a newer manifest key must
never break an install on an older host.

The flip side is that a key an older host does not know is silently ignored, so
you cannot tell from the outside whether it took effect. `ctx.has()` is how you
ask - see [Feature detection](#feature-detection).

> **Wiring status (read this).** All five contribution categories are fully
> consumed by built-in code: `settings`, `commands`, `keybindings`, `panels`,
> and **`aiTools`** (contributed AI tools are surfaced to the agent, see
> Section 5). See [Section 5](#5-contribution-surfaces) for details.

#### `contributes.settings[]`

Rendered as controls on the extension card; values round-trip through the
namespaced `ext:<id>:<key>` settings keys via `ctx.settings`.

| Field         | Required | Notes                                                                                                                                                                                     |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | yes      | The setting key (namespaced to `ext:<id>:<id>` on disk).                                                                                                                                  |
| `type`        | yes      | `"string" \| "number" \| "boolean" \| "select"`.                                                                                                                                          |
| `label`       | yes      | Display label.                                                                                                                                                                            |
| `description` | no       | Helper text.                                                                                                                                                                              |
| `default`     | no       | `string \| number \| boolean \| null`.                                                                                                                                                    |
| `options`     | no       | `{ value: string; label: string }[]`. Used by `select`. **Note:** the schema does _not_ enforce that a `select` has options, a select with no options parses fine, so always supply them. |
| `section`     | no       | `string`. Parsed but **not currently used** by the card (flat list).                                                                                                                      |
| `secret`      | no       | `boolean`. Renders a password input. The schema allows `secret` on any type, not just `string`.                                                                                           |

```json
"settings": [
  {
    "id": "presence",
    "type": "select",
    "label": "Presence detail",
    "description": "How much to share with Discord.",
    "default": "high",
    "options": [
      { "value": "low",  "label": "Low" },
      { "value": "high", "label": "High" }
    ]
  },
  { "id": "apiToken", "type": "string", "label": "API token", "secret": true }
]
```

#### `contributes.commands[]`

A command id is bound to a runtime handler with
`ctx.registerCommandHandler(id, handler)`. Commands surface in the Shortcuts
settings section and are fired by the keybinding dispatcher.

| Field      | Required | Notes                                                |
| ---------- | -------- | ---------------------------------------------------- |
| `id`       | yes      | Stable command id, referenced by keybindings/panels. |
| `title`    | yes      | Display title.                                       |
| `category` | no       | Grouping label.                                      |

```json
"commands": [
  { "id": "tedi.sql-explorer.toggle", "title": "Toggle SQL Explorer", "category": "SQL" }
]
```

#### `contributes.keybindings[]`

| Field     | Required | Notes                                                                                                                                                                                           |
| --------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command` | yes      | A `commands[]` id.                                                                                                                                                                              |
| `key`     | yes      | e.g. `"Mod+Alt+D"`. `Mod` = Cmd on macOS, Ctrl elsewhere.                                                                                                                                       |
| `when`    | no       | **Parsed but NOT evaluated in this version.** A binding with a registered handler fires globally, including while a terminal or the editor is focused. Do not rely on it to scope a keybinding. |

Bindings are matched on a capture-phase `keydown` listener. User overrides
(from `preferences.extensionShortcuts`) win; an empty override clears a binding.

```json
"keybindings": [
  { "command": "tedi.sql-explorer.toggle", "key": "Mod+Alt+D" }
]
```

#### `contributes.panels[]` (`passthrough`)

| Field            | Required | Notes                                                                                                                                                                                                 |
| ---------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | yes      | Bound to a renderer via `ctx.registerPanelRenderer(id, fn)`; controlled via `ctx.panel.*`.                                                                                                            |
| `title`          | yes      | Shown in the host header strip (unless `hideHostHeader`).                                                                                                                                             |
| `surface`        | yes      | `"sidebar-bottom" \| "statusbar-right" \| "right" \| "tab"`. Only **`right`** (slide-out slot) and **`tab`** (full workspace tab) are wired. `sidebar-bottom` / `statusbar-right` are reserved/inert. |
| `icon`           | no       | Path inside the package. Required if `compact:true`.                                                                                                                                                  |
| `defaultOpen`    | no       | `boolean`. Opens the panel once per session at launch (tracked so a user-close is not undone on re-render).                                                                                           |
| `toggleCommand`  | no       | A `commands[]` id; surfaces as a keyboard chip on the toggle button.                                                                                                                                  |
| `hideHostHeader` | no       | `boolean`. Hides the host title+close strip; the extension paints the whole panel and must call `ctx.panel.close` itself.                                                                             |
| `compact`        | no       | `boolean` (added in v0.2.20). Only governs status-bar toggle ordering (compact icon cluster vs text-toggle group). Tolerated on all hosts because the schema is `passthrough`.                        |

`right` example (Secondary Folder Tree):

```json
"panels": [
  {
    "id": "tree",
    "title": "Secondary Folder",
    "surface": "right",
    "icon": "logo.png",
    "defaultOpen": false,
    "toggleCommand": "tedi.secondary-folder-tree.toggle",
    "hideHostHeader": true
  }
]
```

`tab` example (SQL Explorer): pair `surface:"tab"` with the `tabs:open`
permission and open it via `ctx.tabs.openExtensionTab`.

```json
"panels": [
  { "id": "sql-explorer", "title": "SQL Explorer", "surface": "tab",
    "icon": "logo.png", "toggleCommand": "tedi.sql-explorer.toggle" }
]
```

#### `contributes.aiTools[]`

| Field         | Required | Notes                                                                                                                                                                                                                                                                                              |
| ------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | yes      | Tool name the model sees; bind a handler via `ctx.registerAiToolHandler(name, fn)`.                                                                                                                                                                                                                |
| `description` | yes      | Tool description shown to the model.                                                                                                                                                                                                                                                               |
| `parameters`  | yes      | `Record<string, unknown>`, a JSON Schema for the args (wrapped via the AI SDK `jsonSchema()` helper).                                                                                                                                                                                              |
| `approval`    | no       | `"auto" \| "needsApproval"`, defaults to `"auto"`. **Advisory in this version:** every extension tool call routes through the user's tool-approval flow regardless (it prompts in Ask mode, and is auto-approved only if the user enabled that), because the handler is unvetted third-party code. |

**Wired.** Contributed AI tools are merged into the main agent's tool set each
turn (built-in tools always win on a name collision, so you can't shadow
`bash_run` etc.). When the model calls your tool, the host invokes the handler
you registered for that `(extension, name)` and returns its result to the model;
throw or return `{ error }` to signal failure. Tools from a disabled extension
disappear automatically. (Subagents use a fixed read-only tool set and do not
receive extension tools.)

---

## 4. The `ctx` API reference

`ctx` is the host facade passed to `activate(ctx)`.

> **The authoritative copy of everything in this section is `tedi.d.ts`**, which
> `tedi ext create` / `tedi ext types` write into your extension folder. It is
> generated from the same host source this prose describes and a compile-time
> parity check in the TEDI repo fails the build if the two ever disagree, so it
> cannot drift the way a hand-copied type dump can. Prefer hovering the type in
> your editor; read on for the rules the types cannot express.

The shape, abridged:

```ts
type ExtensionOs = {
  platform: "windows" | "macos" | "linux" | "ios" | "android" | "unknown";
  arch: "x86_64" | "aarch64" | "x86" | "arm" | "unknown";
};

type AppContextSnapshot = {
  workspaceCwd: string | null;
  activeFileName: string | null;
  terminalCount: number; // terminal leaves in the ACTIVE workspace
  activeTabKind:
    "terminal" | "ssh" | "editor" | "diff" | "browser" | "ext" | null;
  workspaceCount: number; // >= 1
  terminalCountAll: number; // sum across all workspaces
  // Every live terminal, across all workspaces. See the disclosure note below.
  terminals: {
    ptyId: string;
    ordinal: number;
    state?: "idle" | "working" | "blocking"; // detected AI-CLI run state
    title?: string; // captured OSC 0/2 window title
    wsId?: string;
    wsName?: string;
    wsActive?: boolean;
  }[];
};

type AiStateSnapshot = {
  modelId: string;
  provider: string;
  status: "idle" | "thinking" | "streaming" | "awaiting-approval" | "error";
  step: string | null;
  approvalsPending: number;
  usage: { input: number; output: number; cached: number };
  activeSessionId: string | null;
  approvalMode: "ask" | "semi" | "yolo";
  subagentsEnabled: boolean;
  hasKey: boolean; // a key is configured for `provider`; the key is never exposed
};

type Disposer = () => void;

type ExtensionContext = {
  id: string;
  installPath: string; // absolute install-folder path; join with sidecar paths
  os: ExtensionOs; // static snapshot resolved once at load
  paths: { home: string }; // home dir, no trailing separator; "" if unresolved

  storage: {
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<void>;
  };

  app: {
    getContext(): AppContextSnapshot;
    onContextChange(cb: (snap: AppContextSnapshot) => void): Disposer;
    setSidebarVisible(visible: boolean): void;
    setRightSidebarVisible(visible: boolean): void;
    createWorkspace(
      name: string,
    ): Promise<{ ok: boolean; wsId?: string; error?: string }>; // workspaces:manage
    setActiveWorkspace(wsId: string): Promise<{ ok: boolean; error?: string }>; // workspaces:manage
  };

  settings: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T): Promise<void>;
    onChange(key: string, cb: (value: unknown) => void): Disposer;
  };

  ai: {
    getState(): AiStateSnapshot;
    onStateChange(cb: (state: AiStateSnapshot) => void): Disposer;
    setModel(modelId: string, provider: string): Promise<void>; // ai:configure
    setSubagentsEnabled(enabled: boolean): Promise<void>; // ai:configure
    sendPrompt(text: string): Promise<boolean>; // ai:prompt
    stop(): void;
  };

  invoke<T = unknown>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T>;
  invokeChannel<E = unknown, T = unknown>(
    command: string,
    args: Record<string, unknown> | undefined,
    onEvent: (ev: E) => void,
  ): Promise<T>; // same invoke:<command> gate; streams events via a Tauri Channel

  secrets: {
    get(name: string): Promise<string | null>;
    set(name: string, value: string): Promise<void>;
    delete(name: string): Promise<void>; // secrets:write
  };

  events: {
    emit(name: string, payload?: unknown): Promise<void>;
    on(name: string, cb: (payload: unknown) => void): Promise<Disposer>;
  };

  ui: {
    toast(
      message: string,
      opts?: { variant?: "default" | "success" | "info" | "warning" | "error" },
    ): void;
    mountFolderTree(
      container: HTMLElement,
      options: MountFolderTreeOptions,
    ): { update(opts: MountFolderTreeOptions): void; dispose(): void };
    codeEditor(
      container: HTMLElement,
      opts: CodeEditorOptions,
    ): CodeEditorHandle;
    icon(
      name: string,
      opts?: { size?: number; strokeWidth?: number; className?: string },
    ): HTMLElement;
  };

  statusBar: {
    setItem(item: StatusItem): void;
    removeItem(itemId: string): void;
  };

  headerBar: {
    setItem(item: HeaderItem): void;
    removeItem(itemId: string): void;
  };

  sidebar: {
    setSection(section: SidebarSection): void; // sidebar:write
    removeSection(sectionId: string): void;
  };

  editor: {
    getActive(): { path: string; content: string; dirty: boolean } | null;
    setActiveContent(content: string): boolean;
  };

  tabs: {
    openExtensionTab(opts: {
      panelId: string;
      title: string;
      icon?: string;
      reuseKey?: string;
    }): number | null;
    // Same opts, but mounts the panel as a native split-pane leaf instead of a
    // standalone tab. Also gated by tabs:open.
    openExtensionPane(opts: {
      panelId: string;
      title: string;
      icon?: string;
      reuseKey?: string;
    }): number | null;
    setExtensionTabState(opts: {
      panelId: string;
      reuseKey?: string;
      state: ExtensionTabState | null;
      title?: string;
    }): void;
  };

  shell: {
    registerCommandTransformer(
      transformer: (command: string, kind: "bash" | "terminal") => string,
    ): Disposer; // shell:transform
  };

  ssh: {
    listConnections(): Promise<SafeSshConnection[]>; // ssh:connections
    openConnection(id: string): Promise<{ ok: boolean; error?: string }>;
    closeConnection(sessionId: number): boolean;
  };

  panel: {
    open(panelId: string): void;
    close(panelId?: string): void;
    toggle(panelId: string): void;
  };
  registerPanelRenderer(
    panelId: string,
    renderer: (container: HTMLElement) => Disposer | void,
  ): Disposer;

  contribute: {
    settings(items): void;
    commands(items): void;
    keybindings(items): void;
    panels(items): void; // requires panels:register
    aiTools(items): void;
  };
  registerCommandHandler(
    commandId: string,
    handler: (...args: unknown[]) => unknown,
  ): void;
  registerAiToolHandler(
    toolName: string,
    handler: (args: Record<string, unknown>) => Promise<unknown> | unknown,
  ): void;

  logger: { info(...args): void; warn(...args): void; error(...args): void };
  addDisposer(d: Disposer): void;
};
```

The permission required by each member is listed below. Members marked **none**
have no permission gate by design.

### Feature detection

The API is **additive only**: nothing documented here is ever removed or
renamed. New API arrives in two shapes, and they are detected differently.

**A new method or facade** is already visible - just look:

```js
if (typeof ctx.headerBar?.setItem === "function") ctx.headerBar.setItem({ ... });
```

**A new option field or callback argument** is not. An older host reads your
object, ignores the key it does not know, and quietly gives you the old
behaviour with no error anywhere. `ctx.has(feature)` is the only way to ask:

```js
ctx.ui.codeEditor(el, {
  language: "sql",
  // Silently dropped by hosts older than the release that added it.
  completions: ctx.has?.("codeEditor.completions") ? suggest : undefined,
});
```

Call it optionally (`ctx.has?.(...)`): a host older than `ctx.has` itself has no
such method, and `undefined` is correctly falsy.

| Feature string               | Guards                                                          |
| ---------------------------- | --------------------------------------------------------------- |
| `codeEditor.completions`     | `CodeEditorOptions.completions`                                 |
| `panel.compact`              | `contributes.panels[].compact`                                  |
| `panel.kind.action`          | `contributes.panels[].kind: "action"`                           |
| `panelRenderer.mountContext` | the `{ surface, reuseKey }` second argument to a panel renderer |
| `statusItem.progress`        | `StatusItem.label` / `.progress` / `.detail` / `.kind`          |
| `sidebarSection.contextMenu` | `SidebarSection.onItemContextMenu`                              |

Prefer this over raising `engines.tedi`. Feature detection degrades on an old
host; an engine bump locks you out of it entirely.

### `ctx.has`: none

```ts
has(feature: string): boolean;
```

Ungated. Returns `false` for anything this host has never heard of, which is
the whole point of asking.

### `ctx.id` / `ctx.installPath` / `ctx.os` / `ctx.paths`: none

- `ctx.id`: your extension id.
- `ctx.installPath`: absolute path of your install folder. Join it with a
  sidecar binary path before passing to `shell_bg_spawn_direct`.
- `ctx.os`: `{ platform, arch }`, resolved once at module load (cached;
  falls back to `unknown`/`unknown` on any failure).
- `ctx.paths.home`: the user's home directory as a string, no trailing
  separator, `""` if it cannot be resolved. Cached like `ctx.os`. This is a
  path, not access: reading anything under it still needs the matching
  `invoke:fs_*` permission. Prefer it over shelling out to `echo $HOME` /
  `%USERPROFILE%`, which costs a subprocess and the HIGH-risk
  `invoke:shell_run_command` grant.

### `ctx.storage`: none

A per-extension JSON store backed by a `tedi-ext-<id>.json` LazyStore
(auto-saves). Not permission-gated (already isolated by file). For cached or
large state that does not belong in app settings.

- `get<T>(key): Promise<T | null>`: returns `null` (not `undefined`) when absent.
- `set<T>(key, value): Promise<void>`
- `delete(key): Promise<void>`

### `ctx.app`: none (workspace methods need `workspaces:manage`)

- `getContext(): AppContextSnapshot`: the current app state snapshot (7 fields,
  see the type above). `activeTabKind` is `"browser"` for the browser/preview tab.
  **Disclosure:** `terminals[]` is the widest ungated read in this API. It
  includes each terminal's captured OSC 0/2 title, which for an AI CLI is the
  task the user is running, plus the detected idle/working/blocking state, for
  every workspace. An extension that declares no permissions at all can read it,
  so it is part of what installing _any_ extension grants.
- `onContextChange(cb): Disposer`: fires **once immediately** with the current
  snapshot, then on each shallow-different snapshot. Auto-disposed.
- `setSidebarVisible(visible)`: show/hide the **left** sidebar (file explorer +
  SCM). The host remembers prior visibility and auto-restores it when the user
  switches off your tab.
- `setRightSidebarVisible(visible)`: show/hide the **right** aux column. Exact
  mirror of `setSidebarVisible`: it minimizes the column and back, closing
  nothing, so what you hide is what comes back and `true` really shows it. The
  host remembers prior visibility and auto-restores it when the user switches
  off your tab. Before v0.4.25 this CLOSED the open surfaces instead and `true`
  was a no-op; an extension that relied on the close to tear panels down should
  call the relevant close itself. Both are no-ops with a `console.warn` before
  the App has wired the setter, and while nothing is docked in the column.
- `createWorkspace(name): Promise<{ ok, wsId?, error? }>`: _requires
  `workspaces:manage`._ Creates a workspace and switches to it. The fresh
  workspace auto-seeds a default terminal tab so a mirror can see it.
- `setActiveWorkspace(wsId): Promise<{ ok, error? }>`: _requires
  `workspaces:manage`._ Switches the active workspace by id.

### `ctx.settings`: `settings:read` / `settings:write`

Reads/writes your own namespaced app settings under `ext:<id>:<key>`. Built-in
TEDI prefs are off-limits. Use this for values you also declare in
`contributes.settings[]` so they render on the card.

- `get<T>(key): Promise<T | undefined>`: _requires `settings:read`._ `undefined` when absent.
- `set<T>(key, value): Promise<void>`: _requires `settings:write`._
- `onChange(key, cb): Disposer`: _requires `settings:read`_ (checked synchronously). Filters to your namespaced key. Auto-disposed.

### `ctx.ai`: reads ungated; `ai:configure` / `ai:prompt` for writes

The built-in AI agent. Reads are ungated because the snapshot is strictly less
revealing than `ctx.app.getContext()`, which already exposes every terminal's
window title. Writes are gated because they spend the user's API credit and
steer an agent that can modify files.

- `getState(): AiStateSnapshot`: derived live from the chat and preference
  stores on every call, so it tracks the model/run fields even before the AI
  panel has ever been opened. The one caveat is the earliest moment of app boot:
  `approvalMode` and `subagentsEnabled` come from the preferences store, which
  hydrates asynchronously, so a read in the very first tick of your `activate()`
  can return the defaults (`ask` / `true`). If you need the saved values, read
  them from `onStateChange` rather than a single `getState()` at startup. See the
  type above.
- `onStateChange(cb): Disposer`: fires on any agent **or** preference change.
  It does not coalesce, so debounce it if you render from it. Auto-disposed.
- `setModel(modelId, provider): Promise<void>`: _requires `ai:configure`._
  Takes effect on the **next** prompt; an in-flight run stays bound to the model
  it started with. `provider` is required because ids can be shared across
  providers: pass `getState().provider` when you only mean to change the model.
  An unrecognised provider is ignored and the store resolves one from the id.
  The model id is not validated (openai-compatible instances mint ids at
  runtime), so a bad id surfaces on the next run.
- `setSubagentsEnabled(enabled): Promise<void>`: _requires `ai:configure`._
- `sendPrompt(text): Promise<boolean>`: _requires `ai:prompt`._ Submits a turn as
  if the user typed it. Resolves `false` when the composer refused (no API key
  configured, or a run is already active). The agent's own approval flow still
  gates every tool the turn calls.
- `stop(): void`: ungated. Stopping is de-escalating and the user can always do
  it from the UI.

**There is deliberately no `setApprovalMode`.** `approvalMode` is the user's
safety posture, and unlike every other write here it **persists across
restarts**: one call could permanently move the agent to `yolo`, and nothing in
the UI would tell the user it moved. Read it and branch on it (for example, warn
in your panel when it is not `ask`), then ask the user to change it themselves.

Also never exposed, and not by omission: API keys and message history, the
custom-instruction and system-prompt overrides (a persistent injection slot on
every future turn), the openai-compatible instance list (rewriting an instance's
base URL while keeping its id would resend the user's stored bearer token to
another host), and the debug capture (it snapshots full prompts).

```js
export function activate(ctx) {
  const s = ctx.ai.getState();
  ctx.logger.info(
    `model=${s.modelId} provider=${s.provider} hasKey=${s.hasKey}`,
  );
  if (s.approvalMode !== "ask")
    ctx.ui.toast("Heads up: AI approval mode is relaxed.");

  ctx.ai.onStateChange((next) => {
    ctx.statusBar.setItem({
      id: "ai",
      icon: "lucide:Sparkles",
      tooltip: `${next.modelId} (${next.status})`,
      tone: next.status === "error" ? "error" : "default",
      onClick: () => ctx.ai.stop(),
    });
  });
}
```

### `ctx.invoke`: `invoke:<command>`

```ts
// Known command: resolves to its real shape.
ctx.invoke("shell_bg_logs", args): Promise<{ bytes: string; ... }>
// Anything else: resolves to `unknown`, or `<T>` if you supply one.
ctx.invoke<T>(command, args?): Promise<T>
```

Calls a Rust Tauri command. Gated by an `invoke:<command>` permission match
(exact, prefix `invoke:*`, glob `invoke:foo_*`, or `*`). Nine commands are
**hard-denied** even under `*`, see
[Hard-denied `invoke` commands](#hard-denied-invoke-commands).

```js
// permission: "invoke:shell_bg_spawn_direct"
// Resolves to the background HANDLE (a number), not an object.
const handle = await ctx.invoke("shell_bg_spawn_direct", {
  program: `${ctx.installPath}/sidecar/server`,
  args: [],
});
```

#### Typed results

The commands extensions call most resolve to a real shape rather than
`unknown`, so plain JavaScript can read fields off them without a cast:

| Command                 | Resolves to                                                      |
| ----------------------- | ---------------------------------------------------------------- |
| `shell_run_command`     | `{ stdout, stderr, exit_code, timed_out, truncated }`            |
| `shell_bg_spawn_direct` | `number` (the handle)                                            |
| `shell_bg_logs`         | `{ bytes, next_offset, dropped, exited, exit_code }`             |
| `shell_bg_kill`         | `null`                                                           |
| `shell_bg_list`         | `{ handle, command, cwd, started_at_ms, exited, exit_code }[]`   |
| `fs_read_file`          | tagged union on `kind`: `text` / `image` / `binary` / `toolarge` |
| `fs_glob`               | `{ hits: { path, rel }[], truncated }`                           |
| `ssh_list_sessions`     | `{ id, host, user, cols, rows, alive, createdAtMs }[]`           |

Each entry is transcribed from the Rust struct that produces it, casing
included, and a verify script in the TEDI repo reads those structs back and
fails if the two diverge - a shape written from memory would be a type that
lies, which is worse than `unknown`.

Every other command still works exactly the same and resolves to `unknown`.
Narrow it yourself:

```js
const res = await ctx.invoke("my_command", { a: 1 });
const ok = /** @type {{ ok: boolean }} */ (res).ok;
```

> The hard-deny applies only to `ctx.invoke`. A raw `import { invoke } from
"@tauri-apps/api/core"` bypasses it entirely. See [Section 9](#9-security-model).

For commands that stream events through a Tauri `Channel` (for example
`pty_attach`, `ssh_attach`, `http_stream`), use
`ctx.invokeChannel(command, args, onEvent)`: the host creates the channel
internally and passes it as the command's `onEvent` arg. Same `invoke:<command>`
gate, returns the command's resolved value.

**Calling an HTTPS endpoint:** declare `invoke:http_stream` (medium risk) rather
than `invoke:shell_run_command` + `curl` (HIGH: it grants arbitrary local code
execution permanently, and puts any bearer token on a command line). It runs on
the native stack, so webview CORS and preflight do not apply, and it keeps the
app's SSRF and redirect guards. Four traps worth knowing:

```js
// permission: "invoke:http_stream" (+ "invoke:http_abort" to cancel)
const id = crypto.randomUUID();
const parts = [];
let status = 0;
await ctx.invokeChannel(
  "http_stream",
  {
    id,
    method: "GET",
    url,
    headers: [["Authorization", `Bearer ${token}`]], // ARRAY OF PAIRS, not an object
    body: null,
  },
  (ev) => {
    if (ev.type === "meta")
      status = ev.status; // may never arrive
    else if (ev.type === "chunk")
      parts.push(Uint8Array.from(atob(ev.data), (c) => c.charCodeAt(0))); // base64
    else if (ev.type === "error") {
      // http_stream always resolves Ok: failures arrive HERE, not as a rejection
    }
  },
);
// ctx.invoke("http_abort", { id }) cancels an in-flight stream.
```

### `ctx.secrets`: `secrets:read` / `secrets:write`

OS keychain access namespaced to a per-extension service string
(`tedi-ext:<id>`), so extensions can't read each other's or the app's keys via
this facade.

- `get(name): Promise<string | null>`: _requires `secrets:read`._
- `set(name, value): Promise<void>`: _requires `secrets:write`._
- `delete(name): Promise<void>`: _requires `secrets:write`._

### `ctx.events`: `events:emit` / `events:listen`

A Tauri event bus auto-namespaced to a per-extension channel `ext://<id>/<name>`.

- `emit(name, payload?): Promise<void>`: _requires `events:emit`._
- `on(name, cb): Promise<Disposer>`: _requires `events:listen`._ `cb` receives the unwrapped payload. Auto-disposed.

### `ctx.ui.toast`: `ui:toast`

```ts
ctx.ui.toast(message, { variant?: "default" | "success" | "info" | "warning" | "error" })
```

The other `ctx.ui.*` members are **ungated**.

### `ctx.ui.mountFolderTree`: none

Mounts TEDI's built-in FileExplorer (visual parity with the left sidebar) into a
container you own. Auto-disposed on deactivate. Returns `{ update(opts), dispose() }`.

```ts
type MountFolderTreeOptions = {
  rootPath: string | null;
  initialPickedPath?: string | null;
  onPickedPathChange?(path: string | null): void;
  onOpenFile?(path: string, pin?: boolean): void; // default routes through the workspace bridge
  showOpenFolder?: boolean;
  onClose?(): void; // adds an X icon to the header
};
```

### `ctx.ui.codeEditor`: none

Mounts a CodeMirror 6 editor reusing the host bundle. Auto-disposed.

```ts
type CodeEditorOptions = {
  language?:
    | "sql"
    | "sql:mysql"
    | "sql:postgres"
    | "sql:sqlite"
    | "json"
    | "javascript"
    | "http"
    | "plain";
  value?: string;
  readOnly?: boolean;
  onChange?(value: string): void;
  onCmdEnter?(): void; // Mod-Enter
  completions?(prefix: string): { label: string; detail?: string }[];
};
type CodeEditorHandle = {
  setValue(v: string): void;
  getValue(): string;
  focus(): void;
  setLanguage(lang): void;
  dispose(): void;
};
```

> `sql*` and `http` use the CodeMirror legacy stream modes; `json` and
> `javascript` use `@codemirror/lang-json` / `@codemirror/lang-javascript`.
> `plain` resolves to no language extension. An older host that predates a
> language silently falls back to plain text, so opting in never breaks an
> install.

### `ctx.ui.icon`: none

Returns an inline-flex `<span>` mounting a Lucide icon. `name` is a Lucide icon
name (for example `"Plus"`, `"Database"`); a bare name, a `lucide:<Name>`, or a
legacy `hugeicon:<OldName>` ref all resolve. Defaults: `size` 15, `strokeWidth`
1.75. An unknown name yields an empty span plus a warning. Each call mounts a
fresh React root, so for high-frequency rendering cache one element and
`.cloneNode(true)` it. All icon roots are unmounted on deactivate.

```js
const el = ctx.ui.icon("Sun", { size: 16, className: "opacity-80" });
container.appendChild(el);
```

### `ctx.statusBar`: `setItem` needs `statusbar:write`; `removeItem` is ungated

Bottom-right runtime icons. Multiple items per extension (keyed by `item.id`).
All items are removed automatically on deactivate. `removeItem` is intentionally
ungated so you can always remove your own item even after a permission revoke.

```ts
type StatusItem = {
  id: string;
  icon: string; // a Lucide name or "lucide:<Name>", a "data:" URL, or "ext-asset:<relPath>" (legacy "hugeicon:<Name>" still resolves)
  tooltip: string; // "\n" in the string renders as line breaks in the tooltip
  tone?: "default" | "success" | "warning" | "error"; // warning pulses, error adds a red dot
  label?: string; // optional tiny text after the icon (e.g. "62%")
  progress?: number; // optional 0..1 fill: renders a compact progress bar coloured by tone (error red, warning amber, success green, else accent)
  detail?: { title?: string; rows: StatusItemDetailRow[] }; // structured tooltip: one themed progress bar per row; `tooltip` stays the aria-label and the fallback
  onClick?: () => void; // renders the item as a real <button> (focusable, Enter/Space) instead of a decorative <span role="img">
};

type StatusItemDetailRow = {
  label: string;
  progress?: number; // 0..1 fill; draws a real themed bar
  tone?: "default" | "success" | "warning" | "error";
  value?: string; // e.g. "62%"
  note?: string; // muted trailing text, e.g. "resets in 3h 9m"
};
```

Set `onClick` rather than attaching a document-level listener and matching the
host's DOM: the markup is not a contract and a selector will break silently.
A throw inside `onClick` is caught and logged, not allowed to unmount the bar.

### `ctx.headerBar`: `setItem` needs `headerbar:write`; `removeItem` is ungated

Top header-row runtime icons.

```ts
type HeaderItem = {
  id: string;
  icon: string; // a Lucide name or "lucide:<Name>", or a file/data: asset
  tooltip: string;
  tone?: "default" | "success" | "warning" | "error";
  placement?: "left" | "right"; // default "right" (top header, near Extensions/Settings);
  // "left" is NOT the top header: it renders in the focused editor pane's own
  // header, beside the markdown-preview / word-wrap toggles and the float
  // button, at that row's smaller 20px scale. Only one copy exists at a time,
  // on the pane whose buffer `ctx.editor` reads - and nothing shows while a
  // terminal, browser or extension pane has focus. Use it for actions on the
  // active file (format, lint, view-as); anything global belongs on "right".
  onClick: (event: MouseEvent) => void; // REQUIRED; host wraps in try/catch
};
```

### `ctx.sidebar`: `sidebar:write`

Contribute a left-sidebar section rendered with the Workspaces-panel chrome (h-8
header + icon + title + action buttons, then a scrollable row list). The section
appears as a reorderable, collapsible `AppSidebar` entry (keyed
`xsec:<extId>:<sectionId>`) only while your extension is active, so it shows and
hides with enable/disable. Re-call `setSection` with the same `id` to update the
row list (for example after a connection is added).

- `setSection(section): void`: the descriptor carries `headerActions` and
  `items` (each with optional `actions`, `tone`, `active`), plus
  `onItemClick` / `onItemAction` / `onHeaderAction` callbacks.
- `removeSection(sectionId): void`

Backed by `sidebarSectionsRegistry`. The SQL Explorer uses it for its connection
list.

### `ctx.editor`: `editor:read` / `editor:write`

- `getActive()`: _requires `editor:read`._ Returns `{ path, content, dirty }`
  for the focused editor leaf, or `null` (terminal/browser/settings/ext tab, or
  bridge not wired). `content` is the **live, possibly dirty** buffer.
- `setActiveContent(content): boolean`: _requires `editor:write`._ Replaces the
  whole buffer in one CodeMirror transaction. The user sees a dirty buffer
  (undoable, must Ctrl+S to persist). Returns `false` if the bridge is unset.

### `ctx.tabs`: `tabs:open`

- `openExtensionTab({ panelId, title, icon?, reuseKey? }): number | null`:
  opens a full workspace tab that mounts the renderer registered for `panelId`
  (pair with a `panels[]` entry whose `surface` is `"tab"`). `reuseKey` dedupes
  (same key focuses the existing tab). Returns the tab index or `null`.
- `openExtensionPane({ panelId, title, icon?, reuseKey? }): number | null`:
  same as `openExtensionTab`, but mounts the panel as a native split-pane leaf
  (same frame as a terminal/editor/browser, splittable and joinable) instead of
  a standalone tab.
- `setExtensionTabState({ panelId, reuseKey?, state })`: tints the tab title to
  a lifecycle tone matched on `(panelId, reuseKey)`; `null` clears. Tones mirror
  the SSH palette: `connecting`/`reconnecting` pulse yellow, `connected` green,
  `disconnected`/`error` red.

### `ctx.shell.registerCommandTransformer`: `shell:transform`

```ts
ctx.shell.registerCommandTransformer((command: string, kind: "bash" | "terminal") => string): Disposer
```

Rewrites shell commands before AI tools run them. `kind` is `"bash"` for hidden
agent shells (`bash_run`/`bash_background`) and `"terminal"` for the visible PTY
(`suggest_command`/`run_in_terminal`). One transformer per extension (a second
call replaces it). Transformers chain in insertion order; each is wrapped in
try/catch and **non-string returns are dropped** (the original command survives).
Auto-disposed.

```js
// RTK Bridge pattern
ctx.shell.registerCommandTransformer((cmd, kind) => {
  if (kind === "bash" && /^(git|npm|cargo)\b/.test(cmd)) return `rtk ${cmd}`;
  return cmd;
});
```

### `ctx.ssh`: `ssh:connections`

Read-only-ish access to the user's saved SSH hosts. The extension never sees a
password or key: only the connection id crosses the boundary, and the app's own
keychain-backed connect flow does the rest.

- `listConnections(): Promise<SafeSshConnection[]>`: secret-free metadata
  (`id`/`name`/`host`/`user` + a `pinned` flag) for each saved host.
- `openConnection(id): Promise<{ ok, error? }>`: opens the connection by id as a
  real SSH tab. Refuses a host with no pinned server key, so a remote caller can
  never trigger a first-connect host-key prompt (which needs desktop verification).
- `closeConnection(sessionId): boolean`: closes the SSH tab whose live session
  id is `sessionId` (from `ssh_list_sessions`). Returns `true` if one closed.

### Right-panel renderer & control: `panels:register` (except `panel.close`)

- `registerPanelRenderer(panelId, renderer): Disposer`: _requires
  `panels:register`._ The host hands your `renderer` a fresh `<div>`; return a
  cleanup callback. Pair with a `panels[]` entry. Used for both `surface:"right"`
  and `surface:"tab"`.
- `panel.open(panelId)`: _requires `panels:register`._
- `panel.toggle(panelId)`: _requires `panels:register`._
- `panel.close(panelId?)`: **ungated**, but only acts when the active right
  panel belongs to this extension (and matches `panelId` if given); otherwise a
  silent no-op.

```js
ctx.registerPanelRenderer("tree", (container) => {
  const mounted = ctx.ui.mountFolderTree(container, {
    rootPath: ctx.app.getContext().workspaceCwd,
    onClose: () => ctx.panel.close("tree"),
  });
  return () => mounted.dispose();
});
ctx.registerCommandHandler("tedi.secondary-folder-tree.toggle", () =>
  ctx.panel.toggle("tree"),
);
```

### `ctx.contribute.*`: ungated except `panels`

Imperatively (re)register a contribution slice at runtime. Each call **replaces**
your prior slice for that category (pass `[]` to clear). These overwrite whatever
was seeded from the manifest. Among the runtime `contribute.*` calls only
`contribute.panels` is gated (on `panels:register`); the others are ungated.
Note the asymmetry: a `contributes.panels[]` entry **declared in the manifest**
is seeded without any permission and renders its status-bar toggle, so
`panels:register` gates the renderer and the imperative open/toggle controls,
not the existence of the panel entry.

```js
ctx.contribute.settings([
  { id: "verbose", type: "boolean", label: "Verbose logs", default: false },
]);
ctx.contribute.commands([{ id: "acme.run", title: "Run" }]);
```

### `ctx.registerCommandHandler` / `ctx.registerAiToolHandler`: none

- `registerCommandHandler(commandId, handler)`: bind a runtime handler to a
  contributed command id. The handler fires when the command runs (keybinding or
  Shortcuts UI).
- `registerAiToolHandler(toolName, handler)`: binds the handler the agent calls
  when it invokes your contributed `aiTools[]` tool. `handler(args)` receives the
  model's parsed arguments and returns a JSON-serialisable result (or `{ error }`
  / throws on failure). Pair it with a `contributes.aiTools[]` entry of the same
  `name`. See Section 5 for the full flow + approval behavior.

### `ctx.logger`: none

`info` / `warn` / `error`, each prefixed `[ext:<id>]`.

### `ctx.addDisposer(d)`: none

Pushes `d` onto the disposer stack (run in **reverse** order on deactivate, each
wrapped in try/catch). Most `ctx` wrappers already register their own disposers,
use this only for resources the host can't see (timers, third-party listeners).

---

## 5. Contribution surfaces

How each contribution is rendered or consumed by the built-in app.

### Right slide-out panel (`surface:"right"`)

The host mints a status-bar toggle button from the manifest panel (icon +
tooltip + optional `toggleCommand` shortcut chip). Clicking it (or
`ctx.panel.toggle`) opens a single right column **shared** with the AI chat and
the SCM right panel, your panel takes precedence when active and they are
mutually exclusive. The host renders a title + close strip unless
`hideHostHeader:true`. `defaultOpen:true` opens it once per session at launch.

### Extension tab (`surface:"tab"`)

Opened via `ctx.tabs.openExtensionTab`. Each tab keeps a persistent mount node so
its DOM survives tab switches (inactive tabs are hidden, not torn down). There is
no automatic status-bar toggle for tab panels; trigger them from a command. Tint
the tab title with `ctx.tabs.setExtensionTabState` to reflect connection state.

### Status bar (`ctx.statusBar`)

Items render bottom-right, sorted by `(extId, itemId)`. Icons resolve from a
Lucide name (or `lucide:<Name>`, or a legacy `hugeicon:<Name>`), a `data:` URL,
or an `ext-asset:<relPath>` (SVGs render as a theme-tinted CSS mask; raster as
`<img>`).

### Header bar (`ctx.headerBar`)

Items render in the top header row in two clusters by `placement`: `"right"`
(default, near Extensions/Settings) and `"left"` (file-view-mode area, near the
markdown-preview toggle). `onClick` is required.

### Commands + keybindings

Declared in the manifest, bound at runtime with `ctx.registerCommandHandler`.
The dispatcher reads the keybinding registry on every keydown; user overrides in
preferences win. Commands also appear in the Shortcuts settings section.

### Settings card

`contributes.settings[]` render as a flat list of controls (Switch / Input /
number / select / password). Values persist to `ext:<id>:<key>` and round-trip
with `ctx.settings`. The card is seeded even if `activate` throws.

### AI tools (`contributes.aiTools[]`)

Wired into the main agent. Each contributed tool is merged into the model's tool
set every turn with its JSON-Schema args; when the model calls it, your
`registerAiToolHandler` handler runs and its result goes back to the model.
Every extension tool call is **gated by the user's tool-approval flow** (it
prompts in Ask mode; auto-approved only if the user enabled that), the handler
is unvetted third-party code, so it never auto-runs silently. Built-in tools win
on a name collision (you can't shadow `bash_run`), disabled extensions' tools
drop out automatically, and subagents (fixed read-only tool set) don't receive
extension tools. The install dialog discloses each tool's **name and
description** so consent covers the description too, which is the text injected
into the model's tool list every turn. This is the richest seam for turning an
extension into an agent-capability pack.

---

## 6. Permissions reference

The permission gate lives entirely in the JS host facade. Each `ctx.*` call
checks the extension's declared `permissions[]` (recorded at install as
`approved_permissions`). Risk tiers drive the color badges in the install dialog
(high = red, medium = amber, low = neutral).

| Permission          | Risk    | Gates / grants                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings:read`     | low     | `ctx.settings.get`, `ctx.settings.onChange` (own `ext:<id>:*` keys only).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ai:configure`      | high    | `ctx.ai.setModel`, `ctx.ai.setSubagentsEnabled`. Retargets the agent and spends the user's API credit. There is no `setApprovalMode` at any tier.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ai:prompt`         | high    | `ctx.ai.sendPrompt`. Submits agent turns as if the user typed them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `settings:write`    | medium  | `ctx.settings.set`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `secrets:read`      | high    | `ctx.secrets.get` (service `tedi-ext:<id>`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `secrets:write`     | high    | `ctx.secrets.set`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `invoke:<command>`  | medium† | `ctx.invoke(command, …)`. Matches exact, family-glob (`invoke:foo_*`), or `invoke:*`. **†Rated HIGH** when the command is `fs_*`, `shell_*`, `secrets_*`, `pty_*`, `ssh_*`, or `fmt_run_external` (code-exec / remote-shell / arbitrary-binary; `mcp_*` too, since `mcp_spawn` launches a binary), and for **any glob** (`invoke:*`, `invoke:git_*`, …) since a glob spans a whole command family. Otherwise medium. Prefer exact, least-privilege grants. Some commands (the keychain and extension-management families) are hard-denied outright, see the list below. |
| `events:emit`       | low     | `ctx.events.emit` on `ext://<id>/*`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `events:listen`     | low     | `ctx.events.on` on `ext://<id>/*`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ui:toast`          | low     | `ctx.ui.toast`. (`mountFolderTree` / `codeEditor` / `icon` need no permission.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `panels:register`   | low     | `ctx.registerPanelRenderer`, `ctx.panel.open`, `ctx.panel.toggle`, and the runtime `ctx.contribute.panels`. (`ctx.panel.close` is ungated, and a manifest `contributes.panels[]` entry is seeded without it.)                                                                                                                                                                                                                                                                                                                                                           |
| `statusbar:write`   | low     | `ctx.statusBar.setItem`. (`removeItem` ungated.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `headerbar:write`   | low     | `ctx.headerBar.setItem`. (`removeItem` ungated.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `sidebar:write`     | low     | `ctx.sidebar.setSection`. (`removeSection` ungated.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `tabs:open`         | low     | `ctx.tabs.openExtensionTab`, `ctx.tabs.openExtensionPane`, `ctx.tabs.setExtensionTabState`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `editor:read`       | medium  | `ctx.editor.getActive`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `editor:write`      | medium  | `ctx.editor.setActiveContent`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `workspaces:manage` | medium  | `ctx.app.createWorkspace`, `ctx.app.setActiveWorkspace`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ssh:connections`   | high    | `ctx.ssh.*` (open/close saved SSH connections by id; the extension never sees a password or key).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `shell:transform`   | high    | `ctx.shell.registerCommandTransformer` (rewrites every AI shell command).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `*`                 | high    | Everything checkPermission-gated. Does **not** override the hard-deny set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Members with **no** permission: `ctx.id`, `ctx.installPath`, `ctx.os`,
`ctx.paths.home`, `ctx.storage.*`, `ctx.app.getContext`/`onContextChange`/
`setSidebarVisible`/`setRightSidebarVisible` (but **not**
`ctx.app.createWorkspace`/`setActiveWorkspace`, which need `workspaces:manage`),
`ctx.ai.getState`/`onStateChange`/`stop`,
`ctx.ui.mountFolderTree`/`icon`/`codeEditor`,
`ctx.panel.close`, `ctx.statusBar.removeItem`, `ctx.headerBar.removeItem`, all
`ctx.contribute.*` except `panels`, `ctx.registerCommandHandler`,
`ctx.registerAiToolHandler`, `ctx.logger.*`, `ctx.addDisposer`.

### Matching rules

- **Exact**: `"editor:read"` matches `editor:read`.
- **Category wildcard**: a declared `"settings:*"` matches `settings:read` and
  `settings:write` (the colon is kept).
- **Glob**: any declared string containing `*` is compiled to a regex, e.g.
  `"invoke:foo_*"` -> `/^invoke:foo_.*$/`. `*` is greedy and crosses underscores
  and colons.
- **`*`**: grants everything checkPermission-gated.

### Hard-denied `invoke` commands

`ctx.invoke` refuses these even with `invoke:*` or `*`.

The keychain four, because their raw `(service, account)` signature would
otherwise let an extension read the main app's keys (service `tedi`) or another
extension's keys, sidestepping the `tedi-ext:<id>` namespace:

```
secrets_get_all   secrets_get   secrets_set   secrets_delete
```

Use `ctx.secrets` for your own keys.

The extension-management five, because they mint install-time consent.
`ext_install_from_github` / `ext_install_from_zip` would let one extension
install another and approve its permission set on the user's behalf, and
`ext_enable` / `ext_disable` / `ext_uninstall` would let it silently disarm a
security extension or resurrect a disabled one:

```
ext_install_from_zip   ext_install_from_github
ext_enable   ext_disable   ext_uninstall
```

There is deliberately no `ctx` facade for these: installing or disabling an
extension is a user action that goes through the review dialog. The read-only
ones (`ext_list`, `ext_read_manifest`, `ext_check_update`) stay available with
the matching `invoke:` grant.

### Request least privilege

Declare exactly the permissions you use, prefer narrow `invoke:<exact_command>`
over `invoke:*`, and **do not request `*`**. It renders a red HIGH badge that
scares users. Adding a new permission in a later version also re-prompts the
user at update time (Section 9), so request only what you need from day one.

---

## 7. Lifecycle

### Install -> activate -> deactivate -> disable -> uninstall

- **Install** validates the package, extracts it atomically to
  `<app_data>/extensions/<id>/`, records state, and (in the main window)
  activates it immediately.
- **Activate** runs the engine gate, **seeds declarative contributions first**
  (so your settings card survives an `activate` throw), builds `ctx`, reads your
  `main` JS, and dynamic-imports it. On throw the host revokes the script, runs
  disposers, re-seeds contributions, and rethrows.
- **Deactivate** awaits your `deactivate()`, then runs all host disposers in
  reverse order, then clears every per-extension registry, then revokes the
  script URL.
- **Disable** flips the `enabled` flag in `state.json` and deactivates; the
  folder stays on disk.
- **Enable** re-activates a fresh instance.
- **Uninstall** deactivates, then removes the folder and the state entry.

### Fresh module per activation

Each activation reads your JS text, wraps it in a `Blob`, mints a new
`URL.createObjectURL`, and `import()`s it. Because the URL is new every time, the
browser treats it as a **fresh module instance**, module-level state resets
cleanly between enable/disable cycles. The Blob URL is revoked on deactivate.

### Hot reload

Save your bundle and the running extension restarts by itself, typically within
a second or two. No window reload, no re-install, no toggling it off and on.
`manifest.json` counts too, so adding a command, a panel or a permission also
takes effect on save.

```bash
npm run watch     # src/ -> extension.js on every save; TEDI does the rest
```

What actually happens: the host polls the mtime and length of your
`manifest.json` and `manifest.main` about once a second (only while the window
is visible), and when they change it runs the ordinary
deactivate -> activate cycle - the same one an update or a manual toggle uses.
So the rules below about disposers and idempotent `deactivate` apply on every
save, and a leak that only shows up after ten reloads will now show up in the
first minute of development. That is a feature.

Three details worth knowing:

- **A change has to settle before it reloads.** A bundler writes its output in
  chunks, so the host waits until the file stops changing between two polls
  before importing it. Without that, a poll landing mid-write imports a
  truncated module and fails activation for code you wrote correctly.
- **A broken `manifest.json` is recoverable.** An unparseable manifest drops
  the extension out of the list, but the host keeps watching its files anyway,
  so fixing the typo brings it straight back rather than needing a restart.
- **An `activate` that throws is not fatal.** The failure is toasted, your
  declarative contributions stay seeded, and the next save tries again.

Still restart-only: adding a **brand new** extension folder while the app is
running. `ext_list` enumerates at boot and on demand, so link or install it and
the usual install flow picks it up.

`bootAll` activates every enabled extension in parallel at app boot
(`Promise.allSettled`), so one extension that awaits the network inside
`activate` no longer delays every other extension's contributions from
appearing.

### Two-window sync

The Settings window is a **separate webview** that lists/installs/seeds but never
activates extensions, only the main window does. On any change the active window
emits `tedi://ext-changed` (`{ kind: "installed" | "reloaded" | "removed", id }`);
the main window reloads (or deactivates) accordingly and every window refreshes
its list. The Settings window re-seeds manifest contributions so the Extensions
tab updates without a reload.

> Because the Settings window has its own store instances, any app store your
> runtime reads must be hydrated in both windows.

### Disposer teardown

The host auto-registers disposers for: `settings.onChange`, `events.on`,
`mountFolderTree`, `codeEditor`, `ui.icon` React roots, status/header items (via
registry clear), `shell.registerCommandTransformer`, `registerPanelRenderer`, and
`app.onContextChange`. Anything else you allocate (a `setTimeout`, a WebSocket, a
`document` listener) must be torn down in `deactivate()` or via
`ctx.addDisposer`.

---

## 8. Install / update / packaging

### Packaging

If your extension builds from `src/` (see
[Build pipeline](#build-pipeline-src--extensionjs)), generate the bundle first so
`extension.js` exists, it is git-ignored, so a fresh checkout won't have it:

```bash
npm install && npm run build
```

Then check it before you ship:

```bash
tedi ext validate         # in the extension folder, or pass its path
```

Errors mean something is definitely broken and exit non-zero. Warnings are
things the host tolerates on purpose and exit zero, so this is safe in CI.

| Reported as | Examples                                                                                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **error**   | `main` or `icon` names a file that is not there; a keybinding or `toggleCommand` targets a command id that does not exist; `contributes.panels` without `panels:register`; a `select` setting with no `options`; duplicate ids.                               |
| **warn**    | a permission that matches nothing this host checks (almost always a typo); a hard-denied or glob `invoke:`; no `description` / `icon` / `author` / `engines.tedi` / `$schema`; ids not namespaced under your extension id; scaffold placeholder text left in. |

Every one of those is invisible at runtime otherwise: a keybinding pointing at
a missing command does not throw, it just does nothing, and a misspelled
permission denies a call inside an async handler where the rejection is
unhandled and the button still looks fine.

Then zip the folder so `manifest.json` is at the archive root (single-root
archives auto-unwrap, so a GitHub source zip works too):

```powershell
# PowerShell
Compress-Archive -Path manifest.json,extension.js,logo.png `
  -DestinationPath dist/my-ext-1.0.0.zip -Force
```

```bash
# bash / zsh
zip -j dist/my-ext-1.0.0.zip manifest.json extension.js logo.png
```

### Releasing via CI

Every official extension ships a `.github/workflows/release.yml` that fires on a
`vX.Y.Z` tag, runs `npm ci && npm run build`, zips the built `extension.js` with
`manifest.json` + assets + `sidecar/`, and attaches the zip to a GitHub release.
This is why `extension.js` never needs to be committed: the tag is the only
trigger and CI produces the artifact. The manifest `version` must equal the tag
(the installer reads the version from the manifest, not the tag). To cut a
release: bump `manifest.json` (and `package.json`), update the CHANGELOG, commit,
then `git tag vX.Y.Z && git push --tags`.

Install caps and guards: package <= 50 MiB total, <= 10 MiB per file (counted
from actual decompressed bytes), zip path-traversal rejected, duplicate zip paths
rejected (defeats manifest-spoofing), symlinks written as plain data. On install,
files under `sidecar/` are made executable (Unix `chmod 0755`; Windows strips the
Mark-of-the-Web so SmartScreen lets bundled binaries launch).

### From file / From GitHub (UI)

Drop the zip into _Settings -> Extensions -> From file_, or publish a GitHub
release `.zip` asset and install via _From GitHub_ with your `owner/repo` slug.
GitHub resolution uses `releases/latest`; the version always comes from the
manifest inside the zip (the tag is ignored). Set `TEDI_GITHUB_TOKEN` to raise
the API rate limit. Re-installing the same `manifest.id` replaces on disk and
reloads, that is also how updates work.

### CLI `tedi ext`

A headless surface operating on the same `<app_data>/extensions/` + `state.json`
(registry at <https://tedi.ilhamriski.com/extensions/>). Subcommands also accept
the `--extension` alias.

```
tedi ext install <local.zip | owner/repo | github-url | registry-id>
tedi ext list                # browse the registry, cross-reference installs
tedi ext list --installed    # alias: tedi ext installed
tedi ext update [<id>]       # github sources only
tedi ext uninstall [<id>]
tedi ext enable  [<id>]
tedi ext disable [<id>]
tedi ext                     # interactive menu on a TTY, help otherwise
```

Authoring, none of which touches installed state:

```
tedi ext create [<id>]       # scaffold into ./<id>/  (aliases: init, new)
tedi ext types  [<dir>]      # refresh tedi.d.ts + manifest.schema.json
tedi ext validate [<dir>]    # pre-publish check     (alias: check)
```

`create` and `types` write `tedi.d.ts` and `manifest.schema.json` **out of the
running binary**, so the API you code against always matches the host you are
testing on. Re-run `tedi ext types` after upgrading TEDI to pick up newly added
API; it is the only step needed to stay current.

> The CLI and GUI write the same `state.json` with **no file lock** between
> processes, the later writer wins. Avoid running both against the same install
> at once.

### Recommended release CI

A minimal `.github/workflows/release.yml` on every `vX.Y.Z` tag should:

1. check out the tag,
2. assert `manifest.json` `version` matches the tag,
3. zip the runtime files (`manifest.json`, `main`, icon, assets, sidecar),
4. upload the zip as a release asset.

See the
[Discord example workflow](https://github.com/IlhamriSKY/TEDI.discord-rich-presence/blob/main/.github/workflows/release.yml)
for a copy-pasteable template. Once in place, the **Check updates** button picks
up each new tag.

---

## 9. Security model

**Be honest with yourself about this section before you install anything.**

### The current trust boundary

TEDI extensions run **unsandboxed JavaScript in the main webview realm** with
full app privileges. The runtime reads your `main` JS and executes it via a
Blob-URL dynamic import, the same `window`, `document`, `fetch`, and module
graph as the host. There is no iframe, Web Worker, or membrane. The `ctx` facade
and its permission gate are a **convenience and an advisory layer, not a security
boundary**.

What this means concretely:

- **Raw `@tauri-apps/api` bypasses every `ctx.*` gate.** An extension can
  `import { invoke } from "@tauri-apps/api/core"` and call **any**
  app-registered command directly, including `secrets_get` / `secrets_get_all`
  (reading the user's AI provider keys and SSH credentials), `shell_*`, and
  `fs_*`. The `ctx.invoke` hard-deny and every `requirePermission` check only
  bind the `ctx` facade, not a direct import.
- **CSP is disabled** (`csp: null`). Inline scripts, `eval`, and unrestricted
  network are permitted, so a malicious extension can exfiltrate anything it
  reads.
- **No signature / checksum verification.** GitHub/zip packages are not signed
  (only the app updater is). The recorded folder fingerprint is **not a trust
  anchor**.
- **Updates re-prompt on new permissions.** The GUI install/update review
  diffs the incoming manifest against the permissions you already approved and,
  when a version requests anything new, highlights it and makes you re-approve
  before the update commits, an update can't silently widen its grant through
  the UI. (Caveat: the headless `tedi ext update` CLI applies the install
  pipeline directly without that prompt, and the approved set recorded on
  confirm is still the full manifest set, not a user-trimmed subset, see the
  roadmap below.) `*` still grants everything in one token.

**The install-time review dialog is the real security boundary.** It renders the
manifest permissions as color-coded risk badges and warns that extensions run
JavaScript inside the app. Only install from sources you trust. Native-sidecar
extensions ship arbitrary native code on top of JS, treat them as higher risk.

### What IS protected

- **Install pipeline hardening**: zip path-traversal rejected, duplicate-path
  (manifest-spoofing) zips rejected, size caps against actual decompressed bytes
  (zip-bomb defence), symlinks written as data.
- **Asset reads** are confined to the install folder (`..`/absolute/escape
  rejected) with a 5 MiB cap.
- **Engine-compat gate** at both install and activation.
- **Namespace isolation against accidental collisions**: per-extension event
  channel `ext://<id>/*`, settings namespace `ext:<id>:*`, storage file
  `tedi-ext-<id>.json`, and keychain service `tedi-ext:<id>`. This prevents
  _accidental_ cross-extension reads, not a _malicious_ direct invoke.
- **Thorough teardown** on a well-behaved disable/uninstall.

### Best practices for authors

- **Request least privilege.** Declare only what you use; prefer
  `invoke:<exact_command>` over `invoke:*`; never request `*`.
- **Use the namespaced facades** (`ctx.secrets`, `ctx.settings`, `ctx.events`)
  rather than raw `ctx.invoke` into namespaced commands, it keeps you within
  the documented model and survives future tightening.
- **Be idempotent in `deactivate`** and tear down every resource the host can't
  see.
- **Be transparent about `shell:transform`.** Rewriting AI shell commands is a
  powerful, covert surface; document exactly what you rewrite.

### Security roadmap / known limitations

These are acknowledged, deferred items. They are not implemented today; do not
assume the protection exists:

- **Sandbox the extension realm.** Load `extension.js` inside a sandboxed iframe
  or Web Worker and expose `ctx` only over a postMessage RPC bridge, so the host
  becomes the only code that can touch the DOM/IPC and the permission gate
  becomes enforced rather than advisory.
- **Broker all IPC through the host** with a per-extension capability token, so a
  sandboxed extension has no direct `@tauri-apps/api` access and the hard-deny
  set actually binds.
- **Enable a strict CSP** (`default-src 'self'`; constrained `connect-src`;
  `object-src 'none'`) to stop arbitrary exfiltration.
- **Sign extension packages** and verify the publisher before install; show
  verified identity in the dialog; treat native-sidecar extensions as a distinct
  risk tier.
- **Enforce a user-trimmed permission set.** The GUI now re-prompts on
  newly-requested permissions at update time (implemented), but the _approved_
  set recorded on confirm is still the full manifest set, and the headless
  `tedi ext update` CLI bypasses the prompt. Remaining work: let the user grant
  a subset, persist that distinct approved set, enforce it at runtime, and route
  the CLI update through the same diff.

---

## 10. Lifecycle gotchas & troubleshooting

- **Extension doesn't appear in the list.** The frontend re-validates each
  manifest and silently drops any that fail (check the console for a parse
  warning). Common causes: an unknown top-level key (the manifest is `strict`),
  a non-semver `version`, or an `id` that violates the naming rules.
- **Install fails with a version error.** `engines.tedi` is unsatisfied by the
  host. Loosen the constraint or update TEDI.
- **`activate` threw but my settings card still shows.** Expected: declarative
  contributions are seeded before `activate` runs.
- **My panel/tab is blank.** Make sure you called `ctx.registerPanelRenderer`
  for the same `panelId` as the manifest `panels[]` entry, and that
  `panels:register` is declared. A `surface:"tab"` panel needs `tabs:open` and an
  explicit `ctx.tabs.openExtensionTab` (no auto status-bar toggle).
- **`ctx.editor.getActive()` returns `null`.** No editor leaf is focused
  (terminal/preview/settings/ext tab), or the host bridge isn't wired yet.
- **`ctx.app.set*SidebarVisible` did nothing.** A no-op + warning before the App
  wires the setter; `setRightSidebarVisible(true)` is intentionally a no-op.
- **A setting/store I read isn't updating in the Settings window.** The Settings
  window is a separate webview with its own stores; hydrate any store your
  runtime reads in both windows.
- **My AI tool is never called.** Confirm the `aiTools[]` `name` matches the
  `ctx.registerAiToolHandler(name, …)` you bound, that the extension is enabled,
  and that you didn't reuse a built-in tool name (built-ins win). Also: subagents
  don't get extension tools, only the main agent does.
- **State resets on disable then enable.** By design: each activation is a fresh
  module instance.
- **Module-level state leaked between activations.** It shouldn't (fresh Blob
  URL), but if you cached a `window`-level global yourself, clear it in
  `deactivate()`.
