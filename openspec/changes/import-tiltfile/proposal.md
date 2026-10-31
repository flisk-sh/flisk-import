## Why

Core PR flisk-sh/flisk#2849 added `flisk import tiltfile`, which registers a repo's own Tiltfile in `.flisk/project.json` so `flisk up` runs it unchanged. Core's own design keeps importers in `flisk-import` and runs them from npm at a pinned version, so the importer half of that PR belongs here. Core keeps the half that wraps the registered Tiltfile at `flisk up`.

## What Changes

- New subcommand `flisk-import tiltfile [path] [--dry-run] [--yes] [--force]`. `path` defaults to `Tiltfile`; a directory means `<dir>/Tiltfile`. It is resolved from the working directory, and the project root is the nearest folder with `.flisk/project.json`, else the working directory.
- It writes `orchestration: { source: "tiltfile", path }` into `.flisk/project.json`, with `path` relative to the project root and forward slashes, and keeps every other key. Without a `project.json` it creates the same minimal one as the Compose import, with only the proxy stack.
- It never edits the Tiltfile and writes no `service.json`.
- It refuses, with exit 1: a missing Tiltfile, a path inside `.flisk/`, a path with a quote or control character, an unreadable `project.json`, and an `orchestration` already set unless `--force`.
- `--dry-run` prints the plan and writes nothing. Without `--yes` it asks first; a declined or closed prompt exits 2, as the Compose import does.
- Plain `flisk-import [dir]` stays the Compose import, unchanged.

## Capabilities

### New Capabilities

- `tiltfile-import`: register an existing Tiltfile as the project's orchestration source.

### Modified Capabilities

None. `repo-import` (the Compose import) keeps its behaviour; its `.flisk/project.json` template moves to a shared function and stays byte for byte the same.

## Impact

- `src/tiltfile.ts` (new), `src/cli.ts`, `src/flisk.ts`, `src/write.ts`.
- Tests: `src/__tests__/tiltfile.test.ts`, `e2e/tiltfile.e2e.test.ts`.
- Docs: `README.md`, `docs/import.md`.
- Version 0.4.0. Core then pins `flisk-import@0.4.0` and forwards `flisk import tiltfile` to it, as it forwards `flisk import compose`.
