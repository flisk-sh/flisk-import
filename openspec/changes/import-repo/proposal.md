## Why

A real repo describes one system across many files: a root Compose file, a Dockerfile and a `package.json` per service, a Procfile, a `.env`. Importing one file at a time makes the user stitch the result, and a command that special-cases each format will not survive the 30 detectors in #511.

The unit is a directory. Detectors only claim files and emit candidates. Merge and write are shared, so the tenth importer does not rewrite the command.

## What Changes

- Add `flisk-import [dir]` (default `.`). It scans, detects, merges, prints a plan, and writes only after confirmation. `--dry-run` plans only. `--yes` writes without prompting. `--only <ids>` runs a subset of registered detectors. `--force` is required to overwrite an existing `service.json`.
- Add an importer registry. A detector claims files and emits candidates. It does not write `service.json` and does not know about other detectors.
- Add a candidate model (service, resource, job) with provenance, confidence, and an explicit skip. Merge groups candidates by directory and name. Conflicts are listed, not guessed.
- Ship three detectors that force the merge to be real: Compose, Dockerfile, `package.json` scripts. Procfile (#520) is the fourth, and the smallest, so a one-file importer can land without a schema.
- Do not shell out to `helm`, `kustomize`, or `docker compose config` in this change. A later detector may declare an optional external tool; the core must not require one.
- Do not import Kubernetes, CI, or language manifests here. They register against the same interface later.

## Capabilities

### New Capabilities

- `repo-import`: scan a tree, run registered detectors, merge candidates, report skips and conflicts, and write a TDK landscape without overwriting existing manifests.

### Modified Capabilities

None. `tdk resource` and bring-your-own stay the path for a hand-written service. Import writes the same `service.json` they already accept.

## Impact

- New CLI command and `src/`: registry, scan, candidate types, merge, plan, write. Detectors live in `src/detectors/`.
- New runtime dependency: `yaml` (Compose parsing).
- No engine or Starlark change. Output is ordinary `service.json` plus a printed report.
- Docs: `cli/README.md` and a short `docs/import.md` that says what maps and what is skipped.
- Related: #511 (umbrella), #520 (Procfile detector), #507 (Compose RFC; this change implements the detector, not the docs-only RFC).
- This change is the framework plus the first four detectors. The other rows in #511 are later changes against the same registry.
