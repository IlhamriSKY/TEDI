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
  advisory convenience, not a sandbox. See [Section 9](#9-security-model) — read
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

| Extension                 | Install string                          | Demonstrates                                                                                                                                                                                                             |
| ------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Beautify**              | `IlhamriSKY/TEDI.beautify`              | `headerbar:write` with `placement:"left"`, `editor:read`/`editor:write` live-buffer round-trip, native sidecar via `shell_bg_spawn_direct` + `READY {port,token}` handshake, multi-language formatting in a Rust binary. |
| **Discord Rich Presence** | `IlhamriSKY/TEDI.discord-rich-presence` | `app.onContextChange`, `statusbar:write`, permission-gated `invoke`, idempotent `deactivate`, native sidecar binary.                                                                                                     |
| **SQL Explorer**          | `IlhamriSKY/TEDI.sql-explorer`          | `panels[]` with `surface:"tab"` + `tabs:open`, `headerbar:write`, `settings:*`, `secrets:*`, sidecar HTTP server, `ctx.ui.codeEditor` (SQL).                                                                             |
| **Secondary Folder Tree** | `IlhamriSKY/TEDI.secondary-folder-tree` | `panels[]` `surface:"right"`, `commands` + `keybindings`, `ctx.registerCommandHandler`, `ctx.panel.toggle`, `ctx.ui.mountFolderTree`.                                                                                    |
| **Screenshot**            | `IlhamriSKY/TEDI.screenshot`            | `panels[]` used only to mint a status-bar toggle, then a capture-phase click interception, native sidecar.                                                                                                               |
| **RTK Bridge**            | `IlhamriSKY/TEDI.rtk-bridge`            | `shell:transform` rewriting every AI shell command (RTK pattern).                                                                                                                                                        |

---

## 2. Quick start

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
    icon: "hugeicon:Sun01Icon", // see ctx.ui.icon for the icon name set
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
  called multiple times in a session — keep it idempotent.
- A `main` file with **no** `activate` export logs a warning but keeps your
  declarative contributions.
- Omit `main` entirely for a **pure-declarative pack** (themes / settings only,
  though see the dead-registry caveats in Section 5).

---

## 3. Package layout & manifest schema

### Package layout

```
<id>/
├── manifest.json        required, at the archive root
├── extension.js         optional ES module exporting activate(ctx) / deactivate()
├── logo.png             optional icon shown on the Settings -> Extensions card
├── assets/              optional images, css, ...
└── sidecar/             optional native binaries (made executable on install)
```

`<id>` equals `manifest.id` and becomes the on-disk folder name. The installer
auto-unwraps a single-root archive (e.g. a GitHub source zip `repo-<sha>/…`)
when every entry shares one top-level segment **and** that segment contains a
`manifest.json`. A `manifest.json` at the archive root means no unwrap.

### `manifest.json` fields

The schema is validated by Zod on the frontend (`manifest.ts`) and mirrored in
Rust (`manifest.rs`). The top-level object is **strict** on the TS side: any
unknown top-level key fails the parse and the extension is dropped from the list
with a console warning.

| Field         | Required | Type / rules                                                                                                                                                                                                                                                            |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | yes      | `string`, 3–64 chars, regex `^[a-z0-9][a-z0-9\-_.]*[a-z0-9]$` (lowercase kebab/dotted), no leading/trailing dot. Re-validated on every install/read/enable/disable/uninstall to block path traversal. Use a `<publisher>.<feature>` prefix, e.g. `acme.my-integration`. |
| `name`        | yes      | `string`, non-empty (whitespace-only rejected).                                                                                                                                                                                                                         |
| `version`     | yes      | `string`, semver-ish `^\d+\.\d+\.\d+([\-+].*)?$` (TS-strict; Rust only checks non-empty).                                                                                                                                                                               |
| `description` | no       | `string` or `null`.                                                                                                                                                                                                                                                     |
| `author`      | no       | `string` or `null`.                                                                                                                                                                                                                                                     |
| `homepage`    | no       | `string` or `null` (not URL-validated).                                                                                                                                                                                                                                 |
| `icon`        | no       | `string` path inside the package. Read and base64'd for the install dialog; missing icon is non-fatal (falls back to a letter avatar). 5 MiB cap when read live.                                                                                                        |
| `main`        | no       | `string` JS entry path relative to the root. Omit for declarative-only packs. If present it must resolve inside the root and exist, or install fails.                                                                                                                   |
| `permissions` | no       | `string[]`, defaults to `[]`. Glob-style kebab strings (see [Section 6](#6-permissions-reference)). Recorded verbatim at install; no per-string schema validation.                                                                                                      |
| `contributes` | no       | `object`, defaults to `{}`. Unknown contribution categories are tolerated and ignored (`passthrough`).                                                                                                                                                                  |
| `engines`     | no       | `object` with single optional `tedi: string` semver constraint. **Strict** object (no other keys). Checked at install AND activation.                                                                                                                                   |

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

Each contribution array is independently parsed. Every per-item schema below is
**strict** except `panels[]`, which is `passthrough` (so future panel keys, e.g.
`compact`, do not break installs on older hosts).

> **Wiring status (read this).** Of the eight contribution categories, five are
> fully consumed by built-in code: `settings`, `commands`, `keybindings`,
> `panels`, and **`aiTools`** (contributed AI tools are surfaced to the agent —
> see Section 5). The other three — `slashCommands`, `themes`, and
> `editorThemes` — are validated, seeded into registries, and bindable via
> `ctx`, but **no built-in code reads them yet** (no theme injector, no
> slash-command resolver). Treat those three as reserved/forward-looking, and
> note that the install dialog warns the user when a manifest declares them. See
> [Section 5](#5-contribution-surfaces) for details.

#### `contributes.settings[]`

Rendered as controls on the extension card; values round-trip through the
namespaced `ext:<id>:<key>` settings keys via `ctx.settings`.

| Field         | Required | Notes                                                                                                                                                                                      |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`          | yes      | The setting key (namespaced to `ext:<id>:<id>` on disk).                                                                                                                                   |
| `type`        | yes      | `"string" \| "number" \| "boolean" \| "select"`.                                                                                                                                           |
| `label`       | yes      | Display label.                                                                                                                                                                             |
| `description` | no       | Helper text.                                                                                                                                                                               |
| `default`     | no       | `string \| number \| boolean \| null`.                                                                                                                                                     |
| `options`     | no       | `{ value: string; label: string }[]`. Used by `select`. **Note:** the schema does _not_ enforce that a `select` has options — a select with no options parses fine, so always supply them. |
| `section`     | no       | `string`. Parsed but **not currently used** by the card (flat list).                                                                                                                       |
| `secret`      | no       | `boolean`. Renders a password input. The schema allows `secret` on any type, not just `string`.                                                                                            |

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

| Field     | Required | Notes                                                     |
| --------- | -------- | --------------------------------------------------------- |
| `command` | yes      | A `commands[]` id.                                        |
| `key`     | yes      | e.g. `"Mod+Alt+D"`. `Mod` = Cmd on macOS, Ctrl elsewhere. |
| `when`    | no       | Context expression string (grammar not schema-validated). |

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

#### `contributes.slashCommands[]` — reserved

| Field         | Required | Notes                                                                                                                  |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `name`        | yes      | The slash command name.                                                                                                |
| `label`       | yes      | Display label.                                                                                                         |
| `description` | no       | Helper text.                                                                                                           |
| `template`    | no       | Intended to expand `{{selection}}` / `{{cwd}}`, but **no resolver exists** and no UI consumes this registry. Reserved. |

#### `contributes.themes[]` — reserved

| Field    | Required | Notes                                                                                                                 |
| -------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `id`     | yes      | Theme id.                                                                                                             |
| `label`  | yes      | Display name.                                                                                                         |
| `type`   | yes      | `"light" \| "dark"`.                                                                                                  |
| `tokens` | yes      | `Record<string,string>` of CSS var name (without `--`) -> value. **No consumer reads this registry today.** Reserved. |

#### `contributes.editorThemes[]` — reserved

| Field   | Required | Notes                                                                                       |
| ------- | -------- | ------------------------------------------------------------------------------------------- |
| `id`    | yes      | Theme id.                                                                                   |
| `label` | yes      | Display name.                                                                               |
| `css`   | yes      | Path to a CSS file inside the package. **No consumer reads this registry today.** Reserved. |

#### `contributes.aiTools[]`

| Field         | Required | Notes                                                                                                                                                                                                                                                                                              |
| ------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | yes      | Tool name the model sees; bind a handler via `ctx.registerAiToolHandler(name, fn)`.                                                                                                                                                                                                                |
| `description` | yes      | Tool description shown to the model.                                                                                                                                                                                                                                                               |
| `parameters`  | yes      | `Record<string, unknown>` — a JSON Schema for the args (wrapped via the AI SDK `jsonSchema()` helper).                                                                                                                                                                                             |
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

`ctx` is the host facade passed to `activate(ctx)`. Its full TypeScript shape:

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
    | "terminal"
    | "ssh"
    | "editor"
    | "diff"
    | "preview"
    | "ext"
    | null;
  workspaceCount: number; // >= 1
  terminalCountAll: number; // sum across all workspaces
};

type Disposer = () => void;

type ExtensionContext = {
  id: string;
  installPath: string; // absolute install-folder path; join with sidecar paths
  os: ExtensionOs; // static snapshot resolved once at load

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
  };

  settings: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T): Promise<void>;
    onChange(key: string, cb: (value: unknown) => void): Disposer;
  };

  invoke<T = unknown>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T>;

  secrets: {
    get(name: string): Promise<string | null>;
    set(name: string, value: string): Promise<void>;
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
    setExtensionTabState(opts: {
      panelId: string;
      reuseKey?: string;
      state: ExtensionTabState | null;
    }): void;
  };

  shell: {
    registerCommandTransformer(
      transformer: (command: string, kind: "bash" | "terminal") => string,
    ): Disposer;
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
    slashCommands(items): void;
    themes(items): void;
    editorThemes(items): void;
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

### `ctx.id` / `ctx.installPath` / `ctx.os` — none

- `ctx.id` — your extension id.
- `ctx.installPath` — absolute path of your install folder. Join it with a
  sidecar binary path before passing to `shell_bg_spawn_direct`.
- `ctx.os` — `{ platform, arch }`, resolved once at module load (cached;
  falls back to `unknown`/`unknown` on any failure).

### `ctx.storage` — none

A per-extension JSON store backed by a `tedi-ext-<id>.json` LazyStore
(auto-saves). Not permission-gated (already isolated by file). For cached or
large state that does not belong in app settings.

- `get<T>(key): Promise<T | null>` — returns `null` (not `undefined`) when absent.
- `set<T>(key, value): Promise<void>`
- `delete(key): Promise<void>`

### `ctx.app` — none

- `getContext(): AppContextSnapshot` — the current app state snapshot (6 fields,
  see the type above).
- `onContextChange(cb): Disposer` — fires **once immediately** with the current
  snapshot, then on each shallow-different snapshot. Auto-disposed.
- `setSidebarVisible(visible)` — show/hide the **left** sidebar (file explorer +
  SCM). The host remembers prior visibility and auto-restores it when the user
  switches off your tab.
- `setRightSidebarVisible(visible)` — show/hide the **right** aux column. On
  `false` it closes whichever surface is open (AI chat / ext panel / SCM); on
  `true` it is a no-op (the host can't infer which to reopen). Both are no-ops
  with a `console.warn` before the App has wired the setter.

### `ctx.settings` — `settings:read` / `settings:write`

Reads/writes your own namespaced app settings under `ext:<id>:<key>`. Built-in
TEDI prefs are off-limits. Use this for values you also declare in
`contributes.settings[]` so they render on the card.

- `get<T>(key): Promise<T | undefined>` — _requires `settings:read`._ `undefined` when absent.
- `set<T>(key, value): Promise<void>` — _requires `settings:write`._
- `onChange(key, cb): Disposer` — _requires `settings:read`_ (checked synchronously). Filters to your namespaced key. Auto-disposed.

### `ctx.invoke` — `invoke:<command>`

```ts
ctx.invoke<T>(command, args?): Promise<T>
```

Calls a Rust Tauri command. Gated by an `invoke:<command>` permission match
(exact, prefix `invoke:*`, glob `invoke:foo_*`, or `*`). Four keychain
commands — `secrets_get_all`, `secrets_get`, `secrets_set`, `secrets_delete` —
are **hard-denied** even with `*`. Use `ctx.secrets` instead.

```js
// permission: "invoke:shell_bg_spawn_direct"
const { pid } = await ctx.invoke("shell_bg_spawn_direct", {
  program: `${ctx.installPath}/sidecar/server`,
  args: [],
});
```

> The hard-deny applies only to `ctx.invoke`. A raw `import { invoke } from
"@tauri-apps/api/core"` bypasses it entirely. See [Section 9](#9-security-model).

### `ctx.secrets` — `secrets:read` / `secrets:write`

OS keychain access namespaced to a per-extension service string
(`tedi-ext:<id>`), so extensions can't read each other's or the app's keys via
this facade.

- `get(name): Promise<string | null>` — _requires `secrets:read`._
- `set(name, value): Promise<void>` — _requires `secrets:write`._

### `ctx.events` — `events:emit` / `events:listen`

A Tauri event bus auto-namespaced to a per-extension channel `ext://<id>/<name>`.

- `emit(name, payload?): Promise<void>` — _requires `events:emit`._
- `on(name, cb): Promise<Disposer>` — _requires `events:listen`._ `cb` receives the unwrapped payload. Auto-disposed.

### `ctx.ui.toast` — `ui:toast`

```ts
ctx.ui.toast(message, { variant?: "default" | "success" | "info" | "warning" | "error" })
```

The other `ctx.ui.*` members are **ungated**.

### `ctx.ui.mountFolderTree` — none

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

### `ctx.ui.codeEditor` — none

Mounts a CodeMirror 6 editor reusing the host bundle. Auto-disposed.

```ts
type CodeEditorOptions = {
  language?:
    | "sql"
    | "sql:mysql"
    | "sql:postgres"
    | "sql:sqlite"
    | "json"
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

> Only the four SQL variants get a real syntax mode. `json` and `plain`
> currently resolve to **no** language extension (plain text today).

### `ctx.ui.icon` — none

Returns an inline-flex `<span>` mounting a HugeIcon. Defaults: `size` 15,
`strokeWidth` 1.75. An unknown name yields an empty span plus a
`[ext:<id>] unknown HugeIcon: <name>` warning. All icon roots are unmounted on
deactivate.

```js
const el = ctx.ui.icon("Sun01Icon", { size: 16, className: "opacity-80" });
container.appendChild(el);
```

### `ctx.statusBar` — `setItem` needs `statusbar:write`; `removeItem` is ungated

Bottom-right runtime icons. Multiple items per extension (keyed by `item.id`).
All items are removed automatically on deactivate. `removeItem` is intentionally
ungated so you can always remove your own item even after a permission revoke.

```ts
type StatusItem = {
  id: string;
  icon: string; // "hugeicon:<Name>", a "data:" URL, or "ext-asset:<relPath>"
  tooltip: string;
  tone?: "default" | "success" | "warning" | "error"; // warning pulses, error adds a red dot
};
```

### `ctx.headerBar` — `setItem` needs `headerbar:write`; `removeItem` is ungated

Top header-row runtime icons.

```ts
type HeaderItem = {
  id: string;
  icon: string; // "hugeicon:<Name>" (line-art parity) or a file/data: asset
  tooltip: string;
  tone?: "default" | "success" | "warning" | "error";
  placement?: "left" | "right"; // default "right" (near Extensions/Settings);
  // "left" sits in the file-view-mode area near the markdown-preview toggle
  onClick: (event: MouseEvent) => void; // REQUIRED; host wraps in try/catch
};
```

### `ctx.editor` — `editor:read` / `editor:write`

- `getActive()` — _requires `editor:read`._ Returns `{ path, content, dirty }`
  for the focused editor leaf, or `null` (terminal/preview/settings/ext tab, or
  bridge not wired). `content` is the **live, possibly dirty** buffer.
- `setActiveContent(content): boolean` — _requires `editor:write`._ Replaces the
  whole buffer in one CodeMirror transaction. The user sees a dirty buffer
  (undoable, must Ctrl+S to persist). Returns `false` if the bridge is unset.

### `ctx.tabs` — `tabs:open`

- `openExtensionTab({ panelId, title, icon?, reuseKey? }): number | null` —
  opens a full workspace tab that mounts the renderer registered for `panelId`
  (pair with a `panels[]` entry whose `surface` is `"tab"`). `reuseKey` dedupes
  (same key focuses the existing tab). Returns the tab index or `null`.
- `setExtensionTabState({ panelId, reuseKey?, state })` — tints the tab title to
  a lifecycle tone matched on `(panelId, reuseKey)`; `null` clears. Tones mirror
  the SSH palette: `connecting`/`reconnecting` pulse yellow, `connected` green,
  `disconnected`/`error` red.

### `ctx.shell.registerCommandTransformer` — `shell:transform`

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

### Right-panel renderer & control — `panels:register` (except `panel.close`)

- `registerPanelRenderer(panelId, renderer): Disposer` — _requires
  `panels:register`._ The host hands your `renderer` a fresh `<div>`; return a
  cleanup callback. Pair with a `panels[]` entry. Used for both `surface:"right"`
  and `surface:"tab"`.
- `panel.open(panelId)` — _requires `panels:register`._
- `panel.toggle(panelId)` — _requires `panels:register`._
- `panel.close(panelId?)` — **ungated**, but only acts when the active right
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

### `ctx.contribute.*` — ungated except `panels`

Imperatively (re)register a contribution slice at runtime. Each call **replaces**
your prior slice for that category (pass `[]` to clear). These overwrite whatever
was seeded from the manifest. Only `contribute.panels` is gated (on
`panels:register`); all others are ungated.

```js
ctx.contribute.settings([
  { id: "verbose", type: "boolean", label: "Verbose logs", default: false },
]);
ctx.contribute.commands([{ id: "acme.run", title: "Run" }]);
```

### `ctx.registerCommandHandler` / `ctx.registerAiToolHandler` — none

- `registerCommandHandler(commandId, handler)` — bind a runtime handler to a
  contributed command id. The handler fires when the command runs (keybinding or
  Shortcuts UI).
- `registerAiToolHandler(toolName, handler)` — binds the handler the agent calls
  when it invokes your contributed `aiTools[]` tool. `handler(args)` receives the
  model's parsed arguments and returns a JSON-serialisable result (or `{ error }`
  / throws on failure). Pair it with a `contributes.aiTools[]` entry of the same
  `name`. See Section 5 for the full flow + approval behavior.

### `ctx.logger` — none

`info` / `warn` / `error`, each prefixed `[ext:<id>]`.

### `ctx.addDisposer(d)` — none

Pushes `d` onto the disposer stack (run in **reverse** order on deactivate, each
wrapped in try/catch). Most `ctx` wrappers already register their own disposers —
use this only for resources the host can't see (timers, third-party listeners).

---

## 5. Contribution surfaces

How each contribution is rendered or consumed by the built-in app.

### Right slide-out panel (`surface:"right"`)

The host mints a status-bar toggle button from the manifest panel (icon +
tooltip + optional `toggleCommand` shortcut chip). Clicking it (or
`ctx.panel.toggle`) opens a single right column **shared** with the AI chat and
the SCM right panel — your panel takes precedence when active and they are
mutually exclusive. The host renders a title + close strip unless
`hideHostHeader:true`. `defaultOpen:true` opens it once per session at launch.

### Extension tab (`surface:"tab"`)

Opened via `ctx.tabs.openExtensionTab`. Each tab keeps a persistent mount node so
its DOM survives tab switches (inactive tabs are hidden, not torn down). There is
no automatic status-bar toggle for tab panels; trigger them from a command. Tint
the tab title with `ctx.tabs.setExtensionTabState` to reflect connection state.

### Status bar (`ctx.statusBar`)

Items render bottom-right, sorted by `(extId, itemId)`. Icons resolve from
`hugeicon:<Name>`, a `data:` URL, or an `ext-asset:<relPath>` (SVGs render as a
theme-tinted CSS mask; raster as `<img>`).

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
prompts in Ask mode; auto-approved only if the user enabled that) — the handler
is unvetted third-party code, so it never auto-runs silently. Built-in tools win
on a name collision (you can't shadow `bash_run`), disabled extensions' tools
drop out automatically, and subagents (fixed read-only tool set) don't receive
extension tools. The install dialog discloses the tool names so the user's
consent is informed. This is the richest seam for turning an extension into an
agent-capability pack.

### Reserved surfaces (not yet consumed)

`slashCommands`, `themes`, and `editorThemes` are validated, seeded, and
bindable, but no built-in code reads their registries today:

- **slashCommands** — no `{{selection}}`/`{{cwd}}` resolver, no consumer.
- **themes / editorThemes** — no stylesheet injector reads the registry.

Do not rely on these three for shipping functionality yet. The install dialog
shows the user a "reserved / no effect in this version" note when a manifest
declares them, and they are documented so your manifest stays
forward-compatible.

---

## 6. Permissions reference

The permission gate lives entirely in the JS host facade. Each `ctx.*` call
checks the extension's declared `permissions[]` (recorded at install as
`approved_permissions`). Risk tiers drive the color badges in the install dialog
(high = red, medium = amber, low = neutral).

| Permission         | Risk    | Gates / grants                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings:read`    | low     | `ctx.settings.get`, `ctx.settings.onChange` (own `ext:<id>:*` keys only).                                                                                                                                                                                                                                                                                                                                |
| `settings:write`   | medium  | `ctx.settings.set`.                                                                                                                                                                                                                                                                                                                                                                                      |
| `secrets:read`     | high    | `ctx.secrets.get` (service `tedi-ext:<id>`).                                                                                                                                                                                                                                                                                                                                                             |
| `secrets:write`    | high    | `ctx.secrets.set`.                                                                                                                                                                                                                                                                                                                                                                                       |
| `invoke:<command>` | medium† | `ctx.invoke(command, …)`. Matches exact, family-glob (`invoke:foo_*`), or `invoke:*`. **†Rated HIGH** when the command is `fs_*`, `shell_*`, `secrets_*`, `pty_*`, `ssh_*`, or `fmt_run_external` (code-exec / remote-shell / arbitrary-binary), and for **any glob** (`invoke:*`, `invoke:git_*`, …) since a glob spans a whole command family. Otherwise medium. Prefer exact, least-privilege grants. |
| `events:emit`      | low     | `ctx.events.emit` on `ext://<id>/*`.                                                                                                                                                                                                                                                                                                                                                                     |
| `events:listen`    | low     | `ctx.events.on` on `ext://<id>/*`.                                                                                                                                                                                                                                                                                                                                                                       |
| `ui:toast`         | low     | `ctx.ui.toast`. (`mountFolderTree` / `codeEditor` / `icon` need no permission.)                                                                                                                                                                                                                                                                                                                          |
| `panels:register`  | low     | `contribute.panels`, `ctx.registerPanelRenderer`, `ctx.panel.open`, `ctx.panel.toggle`. (`ctx.panel.close` is ungated.)                                                                                                                                                                                                                                                                                  |
| `statusbar:write`  | low     | `ctx.statusBar.setItem`. (`removeItem` ungated.)                                                                                                                                                                                                                                                                                                                                                         |
| `headerbar:write`  | low     | `ctx.headerBar.setItem`. (`removeItem` ungated.)                                                                                                                                                                                                                                                                                                                                                         |
| `tabs:open`        | low     | `ctx.tabs.openExtensionTab`, `ctx.tabs.setExtensionTabState`.                                                                                                                                                                                                                                                                                                                                            |
| `editor:read`      | medium  | `ctx.editor.getActive`.                                                                                                                                                                                                                                                                                                                                                                                  |
| `editor:write`     | medium  | `ctx.editor.setActiveContent`.                                                                                                                                                                                                                                                                                                                                                                           |
| `shell:transform`  | high    | `ctx.shell.registerCommandTransformer` (rewrites every AI shell command).                                                                                                                                                                                                                                                                                                                                |
| `*`                | high    | Everything checkPermission-gated. Does **not** override the hard-deny set.                                                                                                                                                                                                                                                                                                                               |

Members with **no** permission: `ctx.id`, `ctx.installPath`, `ctx.os`,
`ctx.storage.*`, `ctx.app.*`, `ctx.ui.mountFolderTree`/`icon`/`codeEditor`,
`ctx.panel.close`, `ctx.statusBar.removeItem`, `ctx.headerBar.removeItem`, all
`ctx.contribute.*` except `panels`, `ctx.registerCommandHandler`,
`ctx.registerAiToolHandler`, `ctx.logger.*`, `ctx.addDisposer`.

### Matching rules

- **Exact** — `"editor:read"` matches `editor:read`.
- **Category wildcard** — a declared `"settings:*"` matches `settings:read` and
  `settings:write` (the colon is kept).
- **Glob** — any declared string containing `*` is compiled to a regex, e.g.
  `"invoke:foo_*"` -> `/^invoke:foo_.*$/`. `*` is greedy and crosses underscores
  and colons.
- **`*`** — grants everything checkPermission-gated.

### Hard-denied `invoke` commands

`ctx.invoke` refuses these four even with `invoke:*` or `*`, because their raw
`(service, account)` signature would otherwise let an extension read the main
app's keys (service `tedi`) or another extension's keys, sidestepping the
`tedi-ext:<id>` namespace:

```
secrets_get_all   secrets_get   secrets_set   secrets_delete
```

Use `ctx.secrets` for your own keys.

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
browser treats it as a **fresh module instance** — module-level state resets
cleanly between enable/disable cycles. The Blob URL is revoked on deactivate.

### No file-watch hot-reload

"Dynamic" means no recompile and runtime load/unload — it does **not** mean a
disk edit is auto-picked-up. To see code changes, re-install (or trigger a
reload). `bootAll` activates all enabled extensions once at app boot, sequentially
(so contributions other extensions depend on are present).

### Two-window sync

The Settings window is a **separate webview** that lists/installs/seeds but never
activates extensions — only the main window does. On any change the active window
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

Zip the folder so `manifest.json` is at the archive root (single-root archives
auto-unwrap, so a GitHub source zip works too):

```powershell
# PowerShell
Compress-Archive -Path manifest.json,extension.js,logo.png `
  -DestinationPath dist/my-ext-1.0.0.zip -Force
```

```bash
# bash / zsh
zip -j dist/my-ext-1.0.0.zip manifest.json extension.js logo.png
```

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
reloads — that is also how updates work.

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

> The CLI and GUI write the same `state.json` with **no file lock** between
> processes — the later writer wins. Avoid running both against the same install
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
Blob-URL dynamic import — the same `window`, `document`, `fetch`, and module
graph as the host. There is no iframe, Web Worker, or membrane. The `ctx` facade
and its permission gate are a **convenience and an advisory layer, not a security
boundary**.

What this means concretely:

- **Raw `@tauri-apps/api` bypasses every `ctx.*` gate.** An extension can
  `import { invoke } from "@tauri-apps/api/core"` and call **any**
  app-registered command directly — including `secrets_get` / `secrets_get_all`
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
  before the update commits — an update can't silently widen its grant through
  the UI. (Caveat: the headless `tedi ext update` CLI applies the install
  pipeline directly without that prompt, and the approved set recorded on
  confirm is still the full manifest set, not a user-trimmed subset — see the
  roadmap below.) `*` still grants everything in one token.

**The install-time review dialog is the real security boundary.** It renders the
manifest permissions as color-coded risk badges and warns that extensions run
JavaScript inside the app. Only install from sources you trust. Native-sidecar
extensions ship arbitrary native code on top of JS — treat them as higher risk.

### What IS protected

- **Install pipeline hardening** — zip path-traversal rejected, duplicate-path
  (manifest-spoofing) zips rejected, size caps against actual decompressed bytes
  (zip-bomb defence), symlinks written as data.
- **Asset reads** are confined to the install folder (`..`/absolute/escape
  rejected) with a 5 MiB cap.
- **Engine-compat gate** at both install and activation.
- **Namespace isolation against accidental collisions** — per-extension event
  channel `ext://<id>/*`, settings namespace `ext:<id>:*`, storage file
  `tedi-ext-<id>.json`, and keychain service `tedi-ext:<id>`. This prevents
  _accidental_ cross-extension reads, not a _malicious_ direct invoke.
- **Thorough teardown** on a well-behaved disable/uninstall.

### Best practices for authors

- **Request least privilege.** Declare only what you use; prefer
  `invoke:<exact_command>` over `invoke:*`; never request `*`.
- **Use the namespaced facades** (`ctx.secrets`, `ctx.settings`, `ctx.events`)
  rather than raw `ctx.invoke` into namespaced commands — it keeps you within
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
- **`activate` threw but my settings card still shows.** Expected — declarative
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
  don't get extension tools — only the main agent does.
- **My slash command / theme / editor theme does nothing.** Those three
  registries have no consumer yet (Section 5); they are reserved and the install
  dialog flags them as such.
- **State resets on disable then enable.** By design — each activation is a fresh
  module instance.
- **Module-level state leaked between activations.** It shouldn't (fresh Blob
  URL), but if you cached a `window`-level global yourself, clear it in
  `deactivate()`.
