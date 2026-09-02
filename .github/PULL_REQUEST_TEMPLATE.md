<!--
PR TITLE FORMAT - it becomes the squash commit message, so it is not optional:

    Type(Scope) [II]: what changed

  Type    Capitalised: Feat, Fix, Chore, Docs, Perf, Refactor, Test, Build, CI, Release
  (Scope) Optional. Capitalised, acronyms stay upper: (Terminal) (UI) (SSH) (AI)
  [II]    YOUR initials - the person who wrote the change, not the merger
  subject Imperative, lower-case first word, no trailing period

Examples:
    Feat(Terminal) [IR]: add split panes
    Fix(Explorer) [KI]: prevent input from disappearing on create
    Chore(Deps) [RF]: bump tauri to 2.x

See CONTRIBUTING.md -> "Commits & PRs" for the full rules.
-->

## What
<!-- One or two sentences describing the change. -->

## Why
<!-- The problem you're solving. Link to the issue if there is one (e.g. "Closes #42"). -->

## How
<!-- Brief notes on the approach, only if non-obvious. -->

## Testing
<!-- How did you verify this works? "Ran tsc clean" is not enough on its own -
     describe the actual flows you exercised. -->

- [ ] `pnpm exec tsc --noEmit` clean
- [ ] Manual smoke-test of the affected feature
- [ ] (If you touched `src-tauri/`) `cargo check` clean
- [ ] (If UI) tested in `pnpm tauri:dev` (isolated dev data dir)

## Screenshots / GIFs
<!-- Required for any UI change. Before / after if applicable. -->

## Notes for reviewer
<!-- Anything risky, anything you want a second opinion on, follow-ups for later. -->
