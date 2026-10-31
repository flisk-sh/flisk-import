## 1. Importer

- [x] 1.1 Add `flisk-import tiltfile [path] [--dry-run] [--yes] [--force]` next to the Compose default action.
- [x] 1.2 Resolve `path` (default `Tiltfile`, a directory means `<dir>/Tiltfile`) from the working directory; root is the nearest `.flisk/project.json`, else the working directory.
- [x] 1.3 Write `orchestration: { source: "tiltfile", path }` and keep every other key; create the Compose import's minimal `project.json` when absent.
- [x] 1.4 Refuse a missing Tiltfile, a path inside `.flisk/`, a quote or control character, an unreadable `project.json`, and an existing `orchestration` without `--force`.
- [x] 1.5 `--dry-run`, the write prompt and exit codes 0 / 1 / 2 as in the Compose import.

## 2. Proof

- [x] 2.1 Unit tests for the plan, the refusals and the write; e2e tests against the built CLI.
- [x] 2.2 README and `docs/import.md`.
- [x] 2.3 Version 0.4.0 (not published).
- [ ] 2.4 Core pins `flisk-import@0.4.0` and forwards `flisk import tiltfile` to it (flisk-sh/flisk#2849).
