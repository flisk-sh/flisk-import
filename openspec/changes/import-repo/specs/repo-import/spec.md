## ADDED Requirements

### Requirement: Import scans a tree and only runs registered detectors

`flisk-import [dir]` SHALL walk the given directory (default `.`), skip `.git`, dependency and build directories, and paths ignored by `.gitignore`, and SHALL NOT follow symlinks. It SHALL run only detectors in the registry. `--only` SHALL select a subset by id and SHALL fail before walking when an id is unknown. The command MUST NOT shell out to Helm, kustomize, or Docker Compose.

#### Scenario: Unknown detector id fails closed

- **WHEN** a user runs `flisk-import . --only procfile,helm`
- **THEN** the command exits non-zero
- **AND** the error lists the registered ids
- **AND** no file is written

#### Scenario: Ignored directories are not imported

- **WHEN** the tree contains `node_modules/left-pad/package.json` and a root `Procfile`
- **THEN** the plan does not include a service from `node_modules`
- **AND** the Procfile is still detected

### Requirement: A detector emits candidates, not manifests

A detector SHALL claim files and emit candidates with kind, suggested name, directory key, only the fields it knows, confidence, and source path. It MUST NOT write `service.json`. Adding a detector SHALL NOT require a change to the writer.

#### Scenario: Procfile becomes one candidate per process

- **WHEN** a Procfile contains `web: npm start` and `worker: node worker.js`
- **THEN** the plan lists two services
- **AND** each names the Procfile as its source
- **AND** no port is taken from the source files

#### Scenario: Procfile release process is a job

- **WHEN** a Procfile contains `release: npm run migrate`
- **THEN** the plan lists a job named `release`
- **AND** the written manifest sets `restart` to `no`

#### Scenario: Malformed Procfile line is skipped with its location

- **WHEN** a Procfile line has no `name: command` shape
- **THEN** the skip list names the file and the line number
- **AND** the valid lines are still imported

### Requirement: Merge records conflicts instead of guessing

Candidates for the same directory and name SHALL merge. A missing field SHALL be filled from the lower-precedence source. Two different values for the same field SHALL be a conflict: the plan lists both sources, and the written manifest omits that field. Precedence SHALL be Compose, then Dockerfile, then package.json, then Procfile.

#### Scenario: Compose and Dockerfile disagree on the port

- **WHEN** Compose maps service `api` to port 8080 and `api/Dockerfile` exposes 3000
- **THEN** the plan reports a port conflict with both files
- **AND** the written `service.json` takes its port from neither source
- **AND** TDK assigns a free port from its bring-your-own range
- **AND** the service is still created from the fields that agree

#### Scenario: Dockerfile fills a command Compose did not set

- **WHEN** Compose names service `api` with `build: ./api` and no command, and `api/Dockerfile` has a `CMD`
- **THEN** the merged service uses that command
- **AND** the plan lists both files as sources

### Requirement: Write is explicit and does not overwrite

The default SHALL print the plan and ask before writing. `--dry-run` SHALL print the plan and write nothing. `--yes` SHALL write without prompting. An existing `service.json` MUST be left unchanged unless `--force`. A second run with the same inputs and `--force` SHALL produce the same files.

#### Scenario: Dry run writes nothing

- **WHEN** a user runs `flisk-import . --dry-run` in a tree with a Procfile
- **THEN** the plan lists the Procfile services
- **AND** no `service.json` is created or modified

#### Scenario: Existing manifest is kept

- **WHEN** `services/<stack>/api/service.json` already exists and the user runs `flisk-import . --yes` without `--force`
- **THEN** that file is unchanged
- **AND** the report says it was skipped because it exists

### Requirement: The report lists what was not translated

The plan SHALL include a skip list for files a detector claimed but could not translate, and for formats this change does not handle. A skipped Compose feature (`extends`, `profiles`) SHALL name the file and the service. YAML anchors SHALL be resolved and named in the report. The report MUST NOT be written into `service.json`.

#### Scenario: Unsupported Compose construct is named

- **WHEN** a Compose file uses `extends`
- **THEN** the plan says that file used `extends` and was not fully imported
- **AND** services that could be read are still listed
- **AND** the command exits zero if the rest of the plan is valid

### Requirement: First detectors cover the merge shapes

This change SHALL register `compose`, `dockerfile`, `package-json`, and `procfile`. Compose SHALL read services, build, image, command, ports, environment variable names, and depends_on. Environment values MUST NOT be written to `service.json`. Dockerfile SHALL read EXPOSE and CMD into a bring-your-own candidate. package.json SHALL read `start` and `dev` scripts, and SHALL record a Bun or Node runtime on the candidate only when the script plainly uses that runtime. The writer does not map it to a native provider. Procfile SHALL map each process line to a service.

#### Scenario: Three files for one service merge to one manifest

- **WHEN** the tree has a Compose service `api` with `build: ./api`, `api/Dockerfile`, and `api/package.json`
- **THEN** the plan contains one `api` service
- **AND** the plan lists all three files as sources
- **AND** `--yes` writes one `service.json`
