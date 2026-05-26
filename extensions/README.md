# TEDI Extensions: Author Guide

This folder is intentionally minimal. The TEDI release binary ships
**no extensions**. Every extension is installed by the user at runtime
from one of two sources:

| Source       | UI tab in *Settings → Extensions* | Backend command           |
| ------------ | --------------------------------- | ------------------------- |
| Local `.zip` | **From file**                     | `ext_install_from_zip`    |
| GitHub repo  | **From GitHub**                   | `ext_install_from_github` |

Re-installing an extension with the same `manifest.id` replaces the
existing copy on disk and reloads the runtime, so the same two channels
also handle **updates**. The Check / Update buttons next to a card use
the GitHub `releases/latest` endpoint to surface available versions.

---

## Reference extensions (live in their own repos)

| Extension | Repository | Install string |
| --- | --- | --- |
| **Beautify** | <https://github.com/IlhamriSKY/TEDI.beautify> | `IlhamriSKY/TEDI.beautify` |
| **Discord Rich Presence** | <https://github.com/IlhamriSKY/TEDI.discord-rich-presence> | `IlhamriSKY/TEDI.discord-rich-presence` |
| **Secondary Folder Tree** | <https://github.com/IlhamriSKY/TEDI.secondary-folder-tree> | `IlhamriSKY/TEDI.secondary-folder-tree` |
| **Screenshot** | <https://github.com/IlhamriSKY/TEDI.screenshot> | `IlhamriSKY/TEDI.screenshot` |


Each repo has its own [release CI](https://github.com/IlhamriSKY/TEDI.discord-rich-presence/blob/main/.github/workflows/release.yml)
that produces a `.zip` asset on every `vX.Y.Z` tag, exactly the shape
TEDI's installer expects. Open *Settings → Extensions → From GitHub*,
paste the install string above, click **Review → Install**.

| Reference | Covers |
| --- | --- |
| Beautify | `headerbar:write` with `placement: "left"` (file-view-mode cluster, next to the markdown-preview toggle), `editor:read` / `editor:write` for live-buffer round-trip via `ctx.editor.getActive` + `ctx.editor.setActiveContent`, sidecar HTTP server pattern reused from SQL Explorer (`shell_bg_spawn_direct` + `READY {port,token}` handshake), VSCode-parity language dispatch in a Rust binary that links `dprint-plugin-typescript` (JS / TS / JSX / TSX), `dprint-plugin-markdown`, `malva` (CSS / SCSS / LESS / Sass), `markup_fmt` (HTML / Vue / Svelte / Astro), `pretty_yaml`, `toml_edit`, `sqlformat`, and `serde_json`. |
| Discord Rich Presence | `contribute.settings`, `settings.onChange`, `app.onContextChange`, permission-gated `invoke`, idempotent `deactivate`, native sidecar binaries via `shell_bg_spawn_direct`. |
| Secondary Folder Tree | `contribute.panels` (right surface), `contribute.commands` + `contribute.keybindings` for rebindable shortcut, `ctx.registerCommandHandler`, `ctx.panel.toggle`, `ctx.ui.mountFolderTree`, drag-from-tree → drop-on-terminal. |
| Terminal Screenshot | `contribute.panels` (right surface) used purely to mint the status-bar button, then the click is intercepted via a document capture-phase listener so a `position: fixed` floating dropdown opens instead of the right-slot, mapping `data-terminal-leaf-id` → tab `terminalOrdinal` by walking `TabsTrigger` DOM, DOM-side canvas compositing with no extra permissions, clipboard + `<a download>` for persistence. |

When in doubt, copy the layout that's closest to what you're building.

---

## Package layout

```
<id>/
├── manifest.json        required, see schema below
├── extension.js         optional, ES module exporting activate(ctx) / deactivate()
├── logo.png             optional, icon shown in Settings → Extensions card
└── assets/              optional, themes, css, additional images, ...
```

`<id>` follows the manifest naming rules: lowercase ASCII, dot/dash/
underscore allowed, length 3 to 64, no leading or trailing dot. Use a
publisher-scoped prefix to avoid collisions
(`<publisher>.<feature>`, e.g. `acme.my-integration`).

### `manifest.json` schema (v1)

```jsonc
{
  "id": "acme.my-extension",
  "name": "My Extension",
  "version": "1.0.0",                     // semver-ish, x.y.z
  "description": "What it does in one sentence.",
  "author": "Me",
  "homepage": "https://example.com",
  "icon": "logo.png",                     // path inside the package
  "main": "extension.js",                 // optional; omit for declarative-only packs
  "permissions": [
    "settings:read",
    "settings:write",
    "invoke:my_command_*",                // glob form is supported
    "events:emit",
    "events:listen",
    "ui:toast",
    "secrets:read",
    "secrets:write",
    "panels:register",
    "editor:read",
    "editor:write"
  ],
  "contributes": {
    "settings": [
      {
        "id": "enabled",
        "type": "boolean",                // "boolean" | "string" | "number" | "select"
        "label": "Publish presence",
        "description": "…",
        "default": false,
        "options": [                      // required when type == "select"
          { "value": "low",  "label": "Low" },
          { "value": "high", "label": "High" }
        ]
      }
    ],
    "commands":      [ { "id": "my.cmd",    "title": "…" } ],
    "keybindings":   [ { "command": "my.cmd", "key": "Mod+K" } ],
    "slashCommands": [ { "name": "todo", "label": "Add TODO", "template": "TODO: " } ],
    "themes":        [ { "id": "dracula", "label": "Dracula", "type": "dark",
                          "tokens": { "primary": "#bd93f9" } } ],
    "editorThemes":  [ { "id": "dracula", "label": "Dracula", "css": "themes/dracula.css" } ],
    "panels":        [ {
                          "id": "logs", "title": "Logs",
                          "surface": "right",                  // only "right" is wired today
                          "icon": "logo.svg",
                          "defaultOpen": false,                // auto-open once per session
                          "toggleCommand": "myext.toggleLogs", // links to contributes.commands
                          "hideHostHeader": true               // hide host's title strip; ext owns chrome
                        } ],
    "aiTools":       [ { "name": "lookup", "description": "…", "parameters": { } } ]
  },
  "engines": { "tedi": ">=0.2.6" }
}
```

`type: "select"` settings auto-render as a `<select>` in the card.
`type: "string"` with `"secret": true` masks the input. `type: "number"`
accepts any finite number.

---

## `extension.js` lifecycle

```js
export async function activate(ctx) {
  // ctx.contribute.* registers declarative contributions.
  // ctx.registerCommandHandler / registerAiToolHandler binds runtime
  //   handlers to the corresponding contribution ids.
  // Return value is ignored; throw to fail activation (the host clears
  //   contributions automatically).
}

export async function deactivate() {
  // Optional. Called by the host before disposers run. Tear down
  //   timers, drop connections, etc. Idempotent: disable/uninstall
  //   may call you multiple times across an app session.
}
```

### `ctx` (passed to `activate`)

```ts
type ExtensionContext = {
  id: string;
  // Auto-namespaced under `ext:<id>:<key>` so writes can never reach
  // built-in TEDI preferences.
  settings: {
    get<T>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T): Promise<void>;
    onChange(key: string, cb: (value: unknown) => void): () => void;
  };
  // Per-extension JSON store (tedi-ext-<id>.json) for cached / large
  // state that doesn't belong in the global settings file.
  storage: {
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<void>;
  };
  // OS-keychain access, namespaced to ext:<id>: as well.
  secrets: { get(name): Promise<string|null>; set(name, value): Promise<void> };
  // Tauri commands, gated by `invoke:<cmd>` permission. `secrets_get_all`
  // is hard-denied even with `*`.
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  // Event bus. Emits are auto-namespaced as `ext://<id>/<name>`.
  events: {
    emit(name: string, payload?: unknown): Promise<void>;
    on(name: string, cb: (payload: unknown) => void): Promise<() => void>;
  };
  // Read-only view of "what is the user doing right now".
  app: {
    getContext(): { workspaceCwd: string|null; activeFileName: string|null; terminalCount: number };
    onContextChange(cb): () => void;
  };
  // Contribution helpers (call once on activate; replace by calling
  // again with an empty array). Built-in code reads these registries
  // every render so changes show up immediately.
  contribute: {
    settings(items);
    commands(items);
    keybindings(items);
    slashCommands(items);
    themes(items);
    editorThemes(items);
    panels(items);   // requires `panels:register` permission
    aiTools(items);
  };
  registerCommandHandler(commandId, handler);
  registerAiToolHandler(toolName, handler);
  // Bind a mount function to a `panels[]` entry whose surface is
  // "right". The host auto-renders a status-bar toggle button from
  // the manifest; clicking it (or pressing the bound keybinding)
  // shows a slide-out slot to the right of the workspace
  // (mutual-exclusive with the AI sidebar). The host gives you a
  // fresh <div> to paint into; return a cleanup callback so
  // disable/uninstall tears the panel down cleanly.
  registerPanelRenderer(panelId, (container) => {
    container.appendChild(/* … */);
    return () => container.replaceChildren();
  });
  // Imperative right-panel controls - useful inside a command
  // handler so a keybinding can toggle your panel.
  panel: {
    open(panelId): void;
    close(panelId?): void;     // only acts on this extension's panels
    toggle(panelId): void;
  };
  ui: {
    toast(message, opts?);
    // Mount TEDI's built-in FileExplorer into a container you own.
    // Visual parity with the left sidebar (icons, indent, expand,
    // click-to-open). `onClose` adds an X icon to the header.
    mountFolderTree(container, {
      rootPath: string | null,
      onOpenFile?(path, pin?),
      showOpenFolder?: boolean,
      onClose?(): void,
    }): { update(opts), dispose() };
  };
  shell: {
    // Rewrite every shell command AI tools run (RTK pattern).
    // Requires `shell:transform` permission.
    registerCommandTransformer((cmd, kind) => string): () => void;
  };
  ui: { toast(message, opts?) };
  logger: { info(...), warn(...), error(...) };
  addDisposer(d): void;
};
```

Everything registered via the helpers above is torn down automatically
when the extension is disabled or uninstalled. If you set up any
resource the host can't see (a `setTimeout`, a third-party listener,
…), tear it down yourself in `deactivate()`.

---

## Permissions (`permissions.ts`)

| Permission             | Risk   | What it lets the extension do                                       |
| ---------------------- | ------ | ------------------------------------------------------------------- |
| `settings:read`        | low    | Read its own namespaced settings.                                   |
| `settings:write`       | medium | Write its own namespaced settings.                                  |
| `secrets:read|write`   | high   | OS-keychain access (namespaced).                                    |
| `invoke:<cmd>`         | medium | Call a specific Rust command. Use glob `invoke:foo_*` to allow a group. `invoke:fs_*`, `invoke:shell_*`, `invoke:secrets_*` are HIGH risk. |
| `events:emit|listen`   | low    | Send / receive Tauri events on the `ext://<id>/*` channel.          |
| `ui:toast`             | low    | Show a toast in the main window.                                    |
| `panels:register`      | low    | Declare panels in `contributes.panels[]` AND call `ctx.registerPanelRenderer`, `ctx.panel.{open,close,toggle}`. |
| `statusbar:write`      | low    | Push runtime icons into the status bar via `ctx.statusBar.setItem`. |
| `editor:read`          | medium | Read the active editor's live (possibly dirty) buffer via `ctx.editor.getActive`. |
| `editor:write`         | medium | Replace the active editor's buffer via `ctx.editor.setActiveContent`. The user sees a dirty buffer and can undo or save. |
| `shell:transform`      | high   | Rewrite every shell command AI tools run via `ctx.shell.registerCommandTransformer`. |
| `*`                    | high   | Everything (power-user only).                                       |

`secrets_get_all` is **hard-denied** even with `*`.

---

## Packaging

Package the extension folder so `manifest.json` sits at the archive
root (TEDI also auto-unwraps single-root archives like GitHub source
zips, so either layout works):

```powershell
# PowerShell
Compress-Archive `
  -Path manifest.json,extension.js,logo.png `
  -DestinationPath dist/my-ext-1.0.0.zip `
  -Force
```

```bash
# bash / zsh
zip -j dist/my-ext-1.0.0.zip manifest.json extension.js logo.png
```

Then either drop the zip into *Settings → Extensions → From file*, or
publish it as a GitHub release asset and tell users to install via
*From GitHub* with your `owner/repo` slug.

### Recommended CI (GitHub Actions)

A minimal `.github/workflows/release.yml` that ships a release on
every `vX.Y.Z` tag. See the [Discord example workflow](https://github.com/IlhamriSKY/TEDI.discord-rich-presence/blob/main/.github/workflows/release.yml)
for a copy-pasteable template. The workflow:

1. checks out the tag,
2. asserts `manifest.json` version matches the tag,
3. zips the runtime files,
4. uploads them to the release.

Once that's in place, TEDI’s **Check updates** button will pick up
every new tag you push.

---

## Lifecycle gotchas

- **Disable / uninstall is async.** Don't assume `deactivate()` runs to
  completion before the host clears your contributions: the host
  awaits `deactivate()`, then disposers, then registries, but if you
  hold module-level state make sure it's safe for the extension to be
  re-activated immediately afterwards.
- **Each activate gets a fresh module instance** (the host uses a Blob
  URL per import) so module-level state resets cleanly between
  enable/disable cycles.
- **Two-window sync.** TEDI’s settings window doesn't activate
  extensions; only the main window does. When the user installs from
  the settings window, the main window picks up a `tedi://ext-changed`
  event and runs `loader.reload(id)`.
- **Permission diff on update.** v1 simply records the new manifest's
  permissions on every install. A future version will prompt before
  granting newly-requested permissions. Don't add `*` to your manifest
  if you don't need it. It scares users now and will trigger a
  re-prompt later.
- **Raw `@tauri-apps/api invoke` bypasses host permission gates.** This
  is a known v1 limitation of the "full JS in main webview" trust
  model. The install-time review is the security boundary.
