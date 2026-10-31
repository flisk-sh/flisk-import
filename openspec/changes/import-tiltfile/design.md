## Context

flisk-sh/flisk#2849 implemented `importTiltfile()` inside the core CLI. Core runs the Compose importer as `flisk-import@<pin>` and forwards its arguments, so the Tiltfile importer follows the same path. Core's `flisk import --json` wraps the importer's stdout, so the output stays plain text.

## Goals / Non-Goals

**Goals**

- A stable interface core can forward to: `flisk-import tiltfile [path] [--dry-run] [--yes] [--force]`.
- The same plan, prompt and exit codes (0 / 1 / 2) as the Compose import.
- Refuse a value core's `flisk up` would refuse, so the refusal happens at import time.

**Non-Goals**

- Reading, parsing or rewriting the Tiltfile.
- Translating Tilt resources into `service.json` files.
- Checking the installed core version.

## Decisions

### A subcommand next to the default action

`tiltfile` is a commander subcommand; the program's own action stays the Compose import, so `flisk-import [dir]` is unchanged. Options are positional (`enablePositionalOptions`), so `tiltfile --dry-run` is the subcommand's flag; flags given before `tiltfile` are honoured too. A Compose folder literally named `tiltfile` needs `./tiltfile`.

### Project root

The root is the nearest folder at or above the working directory with `.flisk/project.json`, else the working directory. The PR in core also looked above the Tiltfile's folder; this importer does not, so the root is what the user's shell is in, the same rule the Compose writer uses.

### Path checks

The path is checked before anything is written: a quote (`"` or `'`) or a control character is refused, because core puts the path in its generated wrapper Tiltfile as a string; a path inside `.flisk/` is refused, because that is where core writes its generated files (including the wrapper itself). Single quotes are refused although core's wrapper only rejects double quotes: the stricter check costs a rename and keeps the path safe in any quoting.

### Writing project.json

An existing file is parsed and spread into a new object with `orchestration` set, so every other key and the key order stay; `--force` replaces an existing `orchestration` in place. Any existing `orchestration` value is refused without `--force`, not only a Tiltfile one. A new file uses the shared `defaultProjectConfig()` template (the Compose import's, with only the `proxy` stack) and is created with `flag: "wx"`, so a file created between the plan and the write is not overwritten.

## Risks / Trade-offs

- The created `project.json` template is a copy of the minimum Flisk accepts and can drift from core, as for the Compose import.
- Core must run an imported Tiltfile (flisk#2849); with an older core, `flisk up` ignores `orchestration` and generates its own Tiltfile.
