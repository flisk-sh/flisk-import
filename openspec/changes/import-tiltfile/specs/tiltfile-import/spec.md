## ADDED Requirements

### Requirement: Register an existing Tiltfile

`flisk-import tiltfile [path]` SHALL resolve `path` (default `Tiltfile`) from the working directory, and a directory SHALL mean `<dir>/Tiltfile`. The project root SHALL be the nearest folder at or above the working directory holding `.flisk/project.json`, else the working directory. The command SHALL write `orchestration: { source: "tiltfile", path }` into `<root>/.flisk/project.json`, where `path` is relative to the root with forward slashes, and SHALL keep every other key. It MUST NOT write to the Tiltfile or write any `service.json`.

#### Scenario: New project

- **WHEN** a user runs `flisk-import tiltfile --yes` in a folder with a `Tiltfile` and no `.flisk/project.json`
- **THEN** `.flisk/project.json` is created with the Compose import's minimal template, only the `proxy` stack, and `orchestration` `{ "source": "tiltfile", "path": "Tiltfile" }`
- **AND** the Tiltfile is unchanged

#### Scenario: Existing project

- **WHEN** `.flisk/project.json` exists without `orchestration` and the user imports `dev/Tiltfile`
- **THEN** `orchestration.path` is `dev/Tiltfile` and every other key is unchanged

### Requirement: Refuse what flisk up would refuse

The command SHALL exit 1 with a message and write nothing for a missing Tiltfile, a path inside `.flisk/`, a path with a quote or control character, a `.flisk/project.json` that is not a JSON object, and an `orchestration` already set unless `--force` is passed. With `--force`, it SHALL replace `orchestration` and keep every other key.

#### Scenario: Orchestration already set

- **WHEN** `.flisk/project.json` already sets `orchestration`
- **THEN** `flisk-import tiltfile --yes` exits 1 and names the current value
- **AND** `flisk-import tiltfile --yes --force` replaces it

#### Scenario: Generated Tiltfile

- **WHEN** a user imports `.flisk/.flisk-out/Tiltfile`
- **THEN** the command exits 1 and says the path is inside `.flisk/`

### Requirement: Same flow as the Compose import

The command SHALL print a plan. `--dry-run` SHALL write nothing and exit 0. Without `--yes` it SHALL ask before writing; a declined or closed prompt SHALL print `Nothing written.` and exit 2. `flisk-import [dir]` SHALL remain the Compose import.

#### Scenario: Declined prompt

- **WHEN** a user answers `n` to the write prompt
- **THEN** the command prints `Nothing written.`, exits 2, and writes nothing
