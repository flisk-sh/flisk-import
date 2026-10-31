# Import a Compose project

`flisk import [dir]` reads exactly one file: `<dir>/docker-compose.yml`. It prints a plan, asks before writing, and writes one `service.json` per Compose service. `--dry-run` never writes; `--yes` writes without prompting. It does not start containers. To register a Tiltfile the repo already has instead, see [Import a Tiltfile](#import-a-tiltfile).

```bash
flisk import . --dry-run
flisk import .
flisk import . --yes
```

Each Compose service becomes `services/<stack>/<service>/service.json`, where the stack is the directory name. When the repo is not already a Flisk project, the write also creates `.flisk/project.json` with the imported stack and the Traefik proxy enabled. Existing `service.json` and `.flisk/project.json` files are kept; `--force` overwrites `service.json` files only. The Compose file and the source tree are never changed.

## What maps

| Compose | `service.json` |
| --- | --- |
| `build` (context inside `dir`) | `buildContext` pointing at the original directory, `dockerfile` (default `Dockerfile`). With `build` and `image`, Flisk builds; it does not pull the tag. |
| `image` (no `build`) | `image` |
| one published container port (for example 80, 3000, 5432 or 8080) | `port`, unchanged, because the image already listens there. A bring-your-own port is the port inside its own container: nothing is published on your machine and Traefik reaches it on the stack network, so two services may both use 5432. |
| no single container port | a placeholder port from 4000-5999, and the service stays private (no route). |
| HTTP URL in `healthcheck.test` | `healthCheckPath`. Without one, `/` is assumed and the plan says so. |
| HTTP URL, `host:port/path` or `localhost/path` in `healthcheck.test` | `healthCheckPath`. When no path can be read, `/` is assumed and the plan says so. |
| `depends_on` | `dependsOn`, limited to services in this import |
| `environment` | names in `secrets.required`; literal values appended to the project `.env` (added to `.gitignore`). Keys already in `.env` are kept; `${VAR}` values and names Flisk rejects (lowercase) are listed in the plan instead. |

Every imported service is `appType: "bring-your-own"`. A service whose port is 22, 25, 1883, 2181, 3306, 5432, 5672, 6379, 9092, 9200, 11211 or 27017, or that publishes no single port, is private: `exposeViaProxy: false`, no Traefik route, no health path. Any other single port, including 8000 and 8080, gets a Traefik route.

## What does not map

The plan names each of these. Nothing below is guessed.

- **Other Compose files.** `compose.yaml`, `compose.yml` and `docker-compose.yaml` are not read. Override files (`docker-compose.override.yml` and the rest) are not applied, though `docker compose up` would merge them. Nested Compose files are not read.
- **Service keys other than** `build`, `image`, `ports`, `environment`, `depends_on`, `healthcheck`, `volumes`, `cap_add`, `cap_drop`, `init`, `read_only`, `user`, `security_opt`, `shm_size`, `network_mode` and `restart`. The plan lists the rest per service, for example `command`, `entrypoint`, `env_file`, `networks`. A Compose `command` is not run: the image's own `CMD` runs.
- **Runtime values Flisk cannot take.** An anonymous volume (`/scratch`), an absolute host path (`/var/run/docker.sock`), a path outside the imported directory, or one with `${VAR}` is not mounted. `network_mode` other than `service:<name>` (for example `host`) is not used. A capability, user or security option with characters Flisk refuses, and a restart policy other than `no`, `on-failure`, `unless-stopped` and `always`, is left out. Each is named in the plan.
- **Ports.** Every published port Flisk does not route is written as `extraPorts` and published on `127.0.0.1` only, not on every interface as Compose does. A host port given with `${VAR}` falls back to the container port.
- **Services not written at all:** `profiles`, `extends`, a `build` context outside `dir`, and an `image` with Compose variables such as `postgres:${PG_VERSION:-16}`. A dependency on a service that is not written is dropped and noted.
- **Values Flisk would refuse.** A health path with characters other than `a-z`, `0-9`, `/` and `-` is not used.
- **Ports it cannot read**, such as `${PORT}:${PORT}`. If none of a service's port entries can be read, it is imported as private. If some can, the unreadable ones are ignored and the plan names them. Either way the plan says so.
- **Interpolation and merging.** `docker compose config` is not run; `${VAR}` is not resolved. YAML anchors are resolved and noted.

## Before `flisk up`

1. Check the project `.env`: the import copied literal values from `docker-compose.yml` and lists any it could not (`${VAR}` values).
2. Use Flisk core **1.4.24 or later**. That release reads `container`, `extraPorts`, `sidecarOf` and `volumes` ([flisk#2911](https://github.com/flisk-sh/flisk/pull/2911), [#2912](https://github.com/flisk-sh/flisk/pull/2912), [#2914](https://github.com/flisk-sh/flisk/pull/2914), [#2917](https://github.com/flisk-sh/flisk/pull/2917)); an older core warns that they are unknown fields and runs the services without them. 1.3.104 added `buildContext` ([flisk#525](https://github.com/flisk-sh/flisk/pull/525)); 1.3.145 starts a project that has `.flisk/project.json` but no Tiltfile yet ([flisk#1018](https://github.com/flisk-sh/flisk/pull/1018)); the release after 1.4.10 accepts a bring-your-own port outside 4000-5999 and two-letter names ([flisk#2646](https://github.com/flisk-sh/flisk/pull/2646)). The importer does not check the installed version.
3. Flisk injects its own `PORT`, `DATABASE_URL` and a `Host: <service>.<project>.localhost` header. An app that validates its host or reads `DATABASE_URL` may need configuration that Compose did not.

The command exits 1 when nothing could be imported (an unreadable file, or every service skipped).

## Import a Tiltfile

`flisk import tiltfile [path]` (the package command is `flisk-import tiltfile [path]`) registers a Tiltfile the repo already has as the project's orchestration source. `flisk up` then runs that Tiltfile unchanged instead of generating one. It prints a plan, asks before writing, and writes only `.flisk/project.json`. `--dry-run` never writes; `--yes` writes without prompting; `--force` replaces an `orchestration` that is already set.

```bash
flisk import tiltfile --dry-run
flisk import tiltfile
flisk import tiltfile dev/Tiltfile --yes
```

### Where it looks

- `path` defaults to `Tiltfile`. A folder means `<folder>/Tiltfile`; any other file name, such as `Tiltfile.dev`, is used as given.
- The path is resolved from the current directory. The project root is the nearest folder at or above the current directory with `.flisk/project.json`; without one, it is the current directory.
- The path is written relative to the project root, with forward slashes, for example `dev/Tiltfile` or `../shared/Tiltfile`.

### What it writes

```json
{
  "orchestration": { "source": "tiltfile", "path": "Tiltfile" }
}
```

The key is added to the existing `.flisk/project.json`, and every other key is kept as it was. When the repo is not a Flisk project yet, the import creates the same minimal `.flisk/project.json` as the Compose import, with only the `proxy` stack enabled, plus the `orchestration` key. The Tiltfile and the rest of the source tree are never changed, and no `service.json` is written.

### What it refuses

Each of these exits 1 with the reason and at least one `->` hint, and writes nothing:

- **No Tiltfile** at the path, or a folder without one.
- **A path inside `.flisk/`**, such as `.flisk/.flisk-out/Tiltfile`: that is where Flisk writes its generated Tiltfile, which includes yours. A symlink that leads there, such as `infra/Tiltfile` pointing at `.flisk/.flisk-out/Tiltfile`, is refused too: the real path is compared with the real `.flisk/` folder.
- **A quote or control character** in the path. `flisk up` puts the path in its generated Tiltfile as a string, so rename the file or folder first.
- **An `orchestration` already set** in `.flisk/project.json`, whatever its value. Pass `--force` to replace it.
- **A `.flisk/project.json` that is not valid JSON**, or not a JSON object.
- **A `.flisk/project.json` without the fields `flisk up` needs**: `version`, `project.name` and `project.version`, `phases` (each of `pre_alpha`, `alpha`, `beta` and `out_of_scope` with an `enabledStacks` list), the five `optional_infra` flags, and `discovery.paths`. The error names each one that is missing or has the wrong type. Add them, or recreate the file with `flisk project --yes --force`, which resets it. Writing `orchestration` into such a file would report success and then fail at `flisk up`.

### Exit codes

`0` after `--dry-run` or a write, `1` for a refusal above, `2` when the write prompt is declined or closed without an answer (`Nothing written.`). The output is plain text, like the Compose import; `flisk import --json` wraps it.

### Before `flisk up`

Use a Flisk core that runs an imported Tiltfile ([flisk#2849](https://github.com/flisk-sh/flisk/pull/2849)). It writes `.flisk/.flisk-out/Tiltfile` as a wrapper that includes yours, so relative paths in your Tiltfile still resolve from its own folder. The importer does not check the installed version.

Plain `flisk import [dir]` is still the Compose import. A Compose folder named `tiltfile` needs a path that is not the bare word: `flisk import ./tiltfile`.
