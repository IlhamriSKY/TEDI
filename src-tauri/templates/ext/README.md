# __NAME__

A TEDI extension.

## Develop

```bash
npm install          # once: esbuild + typescript for the checker
npm run watch        # src/ -> extension.js on every save
```

Then load it into TEDI without packaging anything:

- **Settings -> Extensions -> From file** takes a zip, which is slow to iterate
  on. For a live loop, symlink this folder into TEDI's extensions directory
  instead and reload the window (`Ctrl+R`) after each build.
- `tedi ext validate` before you publish. It catches the manifest mistakes
  that otherwise surface as a silently missing button.

## Type checking

`tedi.d.ts` is the typed API contract, and `jsconfig.json` turns it on for
plain JavaScript. `npm run check` type-checks `src/` and parses the bundle.

The copy of `tedi.d.ts` here came from the TEDI binary you scaffolded with.
After upgrading TEDI, run `tedi ext types` in this folder to pick up newly
added API.

## Publish

1. Bump `version` in `manifest.json` (it is the only version source of truth).
2. `npm run build`
3. Zip the extension **at the archive root** - `manifest.json` must be the top
   entry, not nested inside a folder:

   ```bash
   zip -r __ID__.zip manifest.json extension.js README.md LICENSE
   ```

4. Users install it with `tedi ext install ./__ID__.zip`, or through
   **Settings -> Extensions -> From file**.

To publish from GitHub instead, attach the zip to a release; users can then
run `tedi ext install <owner>/<repo>`.

## Permissions

`manifest.permissions` is what the user approves at install time, and it is
frozen at that point - an update that needs a new permission re-prompts. Ask
for the narrowest set that works; the install dialog badges each one and users
do read it.
