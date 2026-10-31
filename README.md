# flisk import

Import the services in a repo's root `docker-compose.yml` into [Flisk](https://github.com/flisk-sh/flisk) as `service.json` files, or register the repo's own Tiltfile so `flisk up` runs it. This is the Compose first tier of flisk-sh/flisk#511.

```bash
flisk import . --dry-run     # plan only
flisk import .               # plan, then ask before writing
flisk import . --yes         # write service.json files and project setup
```

## What to expect

- **Reads one file:** the root `docker-compose.yml`. Not `compose.yaml`, override files, nested Compose files, Dockerfiles on their own, `package.json`, or Procfiles.
- **Writes:** one bring-your-own `service.json` per Compose service, plus `.flisk/project.json` if the repo is not a Flisk project yet. It never edits the Compose file or overwrites a `service.json` without `--force`.
- **Keeps:** the service names (`db` stays `db`, so it stays the hostname), the build context and Dockerfile (or the image), the container port as written (3000, 80, 5432), `depends_on`, and an HTTP health path. Databases and brokers are private, with no proxy route.
- **Runtime keys:** named volumes and bind mounts inside the project (`volumes`), `cap_add`, `cap_drop`, `init`, `read_only`, `user`, `security_opt` and `shm_size` (`container`), extra published ports (`extraPorts`, on 127.0.0.1 only), `network_mode: service:<name>` (`sidecarOf`) and `restart`.
- **Environment:** values that cannot be secrets go into the committed `service.json` `env`: numbers, `true`/`false`, another imported service's address without a user, password or query (`http://invidious:3000`, `redis:6379`), and pure `${VAR}` references. Every other name, and any name that looks like a credential (`PASSWORD`, `TOKEN`, `KEY`, ...), goes into `secrets.required`, with its literal value copied to the project `.env`, which is added to `.gitignore`. Values in `.env` already are kept.
- **Drops, and says so:** `command`, `env_file` and every other untranslated key; anonymous volumes and paths outside the project; `network_mode` other than `service:<name>`; services with `profiles`, `extends`, an out-of-tree build or a `${VAR}` image.
- **Does not start anything.** Run `flisk up` with Flisk core **1.4.24 or later**. The importer does not check the core version.
- **Exit codes:** `0` when the plan succeeds (`--dry-run`, files written, or all `service.json` files already exist), `1` when no root `docker-compose.yml` or mappable service is found, and `2` when the write prompt is declined or closed without an answer (`Nothing written.`).

See [docs/import.md](docs/import.md) for the full mapping and limits. `flisk import` is the core CLI command backed by this package.

## Import a Tiltfile

A repo that already runs on Tilt keeps its own Tiltfile. `flisk-import tiltfile` registers it in `.flisk/project.json`, so `flisk up` runs it unchanged.

```bash
flisk import tiltfile --dry-run          # plan only
flisk import tiltfile                    # plan, then ask before writing
flisk import tiltfile dev/Tiltfile --yes # a named file, or a folder that holds a Tiltfile
```

- **Path:** `[path]` defaults to `Tiltfile`; a folder means `<folder>/Tiltfile`. It is resolved from the current directory. The project root is the nearest folder with `.flisk/project.json`, else the current directory.
- **Writes:** only `.flisk/project.json`, with `"orchestration": { "source": "tiltfile", "path": "<path from the project root>" }`. Every other key is kept. Without a `project.json`, it creates the same minimal one as the Compose import, with only the proxy stack. It never edits the Tiltfile.
- **Refuses (exit 1):** a missing Tiltfile, a path inside `.flisk/` (also through a symlink), a path with a quote or control character, a `project.json` that is not a JSON object or lacks the fields `flisk up` needs, and a `project.json` that already sets `orchestration` (pass `--force` to replace it).
- **Exit codes:** the same as the Compose import: `0` for `--dry-run` or a write, `1` for a refusal, `2` when the prompt is declined or closed (`Nothing written.`).
- **Needs** a Flisk core that runs an imported Tiltfile ([flisk#2849](https://github.com/flisk-sh/flisk/pull/2849)). The importer does not check the core version.

Plain `flisk-import [dir]` is still the Compose import. To import Compose from a folder named `tiltfile`, write `flisk-import ./tiltfile`.

```bash
bun install && bun run build && bun run test
```

## Publishing

`flisk-import` is published to npmjs.org by the workflow in
[`.github/workflows/publish-npm.yml`](.github/workflows/publish-npm.yml), triggered by a
GitHub release. It uses **npm trusted publishing (OIDC)**, so no long-lived npm token
lives in this repository. The package is published under two names: the unscoped
`flisk-import` and the scoped `@flisk-sh/flisk-import` (the same archive with the name
rewritten in the packed manifest).

### One-time owner setup

A trusted publisher has to exist on npm before the first OIDC publish succeeds, and it is
configured per package name:

1. Open the package on npmjs.com → **Settings** → **Trusted Publisher** → **GitHub Actions**
2. Fill in:
   - Organization: `flisk-sh`
   - Repository: `flisk-import`
   - Workflow filename: `publish-npm.yml`
   - Allowed actions: `npm publish`
3. Repeat for `@flisk-sh/flisk-import` once that package exists

The same thing from the command line, for either name:

```bash
npm trust github flisk-import --file publish-npm.yml --repo flisk-sh/flisk-import --allow-publish
npm trust list flisk-import
```

### The first version

A package's first version cannot be published through OIDC — npm has no trusted publisher
for a name that does not exist yet. Version 0.2.2 was therefore published once with a
token; every version after that publishes over OIDC from the release workflow.

