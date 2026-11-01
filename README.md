# flisk import

Import the services in a repo's root `docker-compose.yml` into [Flisk](https://github.com/flisk-sh/flisk) as `service.json` files, or register the repo's own Tiltfile so `flisk up` runs it. This is the Compose first tier of flisk-sh/flisk#511.

```bash
flisk import . --dry-run     # plan only
flisk import .               # plan, then ask before writing
flisk import . --yes         # write service.json files and project setup
```

## What to expect

- **Reads one project:** the root `docker-compose.yml`, or `compose.yaml`, `compose.yml` or `docker-compose.yaml` when that is absent, through `docker compose config --no-interpolate --no-env-resolution --no-path-resolution` when docker compose is installed, so `include:`, `extends` and anchors are resolved as `docker compose up` resolves them (wger keeps db, cache and powersync in `services/*.yaml`), `${VAR}` templates stay as written, and an included file's paths stay relative to its own folder. Without docker compose (or with `FLISK_IMPORT_DOCKER=0`) the file is read as YAML, and the plan says when that leaves `include` or `extends` unresolved. Not override files, Dockerfiles on their own, `package.json`, or Procfiles.
- **Writes:** one bring-your-own `service.json` per Compose service, plus `.flisk/project.json` if the repo is not a Flisk project yet. It never edits the Compose file or overwrites a `service.json` without `--force`.
- **Keeps the install's data:** each named volume gets `name`, the Docker volume `docker compose up` created (`<project>_<volume>`, its own `name:`, or an `external` volume), so `flisk up` mounts the same data with no copy (needs the Flisk release with flisk#2964).
- **Keeps:** `profiles` (the service starts only with `flisk up --profile`), `env_file` as `envFile`, `tmpfs` and `deploy.resources.limits` (`container.tmpfs`, `cpus`, `memory`).
- **Keeps:** `stop_grace_period` (`container.stopGracePeriod`, such as `30s`), the `aliases` of every network (`container.networkAliases`), `extra_hosts` in list or map form (`container.extraHosts`, such as `host.docker.internal:host-gateway`) and `ulimits` (`container.ulimits`). A service renamed to kebab-case (`lychee_api` becomes `lychee-api`) keeps its Compose name as a network alias, so `http://lychee_api:8000` in another service still resolves. `container_name` is dropped with a note: Flisk names containers itself. These fields, an image with variables and `on-failure:N` need the Flisk core release that reads them; an older core does not apply them.
- **Keeps:** the service names (`db` stays `db`, so it stays the hostname), the build context and Dockerfile (or the image), the container port as written (3000, 80, 5432), `depends_on`, and an HTTP health path. Databases and brokers are private, with no proxy route.
- **Runtime keys:** named volumes and bind mounts inside the project (`volumes`), `cap_add`, `cap_drop`, `init`, `read_only`, `user`, `security_opt` and `shm_size` (`container`), extra published ports (`extraPorts`, on the same host address as in Compose: `"80:80"` stays on every interface, `"127.0.0.1:5432:5432"` on loopback, and another address or a `${VAR:-default}` or `${VAR-default}` host side as `publish`), `network_mode: service:<name>` (`sidecarOf`) and `restart`.
- **Environment:** the committed `service.json` `env` gets every pure Compose expression as written, whatever its name (`${DB_PASSWORD:-password}`, `${PORT-8080}`, `${A:-${B:-file}}`), so a fresh clone keeps the defaults, and every literal (`sqlite`, `worker`, `lychee_db`, `http://invidious:3000`) unless its name looks like a credential (`PASSWORD`, `TOKEN`, `KEY`, ...) or the value holds one (a URL with a user or password, a token query parameter, a long random string, a PEM block). Those go into `secrets.required`, with its literal value copied to the project `.env`, which is added to `.gitignore`. Values in `.env` already are kept.
- **Round trip:** a routed port that Compose also publishes (`"${APP_PORT:-8000}:8000"`) stays in `extraPorts` too, and a `healthcheck` stays as `healthCheck.command` (with `interval`, `timeout`, `retries` and `start_period` as `startPeriod`) even when an HTTP path was read, so `flisk-export compose` writes a file that `docker compose` starts the same way (LycheeOrg/Lychee round-trips with no difference but names and aliases). A service with no `restart` keeps none, so Flisk runs it with its default `unless-stopped` (unlike Compose, Flisk then restarts it after a crash or a reboot; the plan says so). `restart: "no"` is written only when Compose sets it or another service waits for this one with `condition: service_completed_successfully`, because Flisk runs a `restart: "no"` service as a one-shot job and waits for it to exit, `healthcheck: { disable: true }` or `test: ["NONE"]` becomes `healthCheck: false`, a value that mixes `${VAR}` with literal text (`${SERVER_NAME:-localhost}, php:80`) stays in `env` unless it could hold a credential, `*_FILE` paths (`POSTGRES_PASSWORD_FILE=/run/secrets/pg`) stay in `env`, and the Compose project name (`name:` or the folder's, such as `pl_mail`) is recorded as `composeProjectNames.<stack>` in `.flisk/project.json`, so `flisk-export compose` keeps the container names. A generated Dockerfile for an image with variables declares them as `ARG NAME=default` before `FROM`.
- **A tracked `.env`:** a repo that commits its `.env` (Symfony) keeps it as it is, and it is not added to `.gitignore`; values that must stay local go to `.env.local` when git already ignores it, else to `.flisk/.env.import` (added to `.gitignore`), and each service that needs them reads that file as `envFile`.
- **Keeps:** a `command` or `entrypoint` on an image as the `CMD`/`ENTRYPOINT` of a small `Dockerfile` next to `service.json` (Flisk sets no container command; a string is split into exec-form arguments as Compose splits it, with no shell, so `command: server /export` on `minio/minio` stays the arguments of its `ENTRYPOINT`; `$$` becomes `$` as Compose passes it to the container; only a string with Compose variables (`${VAR}`, filled from `.env` by Compose, by the container's shell here) or unbalanced quotes runs through `sh -c`, and the plan says so), a `healthcheck` as `healthCheck.command`, a published database port as `extraPorts`, and `restart: on-failure:N` with its retry limit (N from 1 to 100).
- **Drops, and says so:** `command` on a service with a `build`, `env_file` and every other untranslated key; anonymous volumes and paths outside the project; `network_mode` other than `service:<name>`; services with invalid profile names, `extends`, an out-of-tree build, or an image with characters or variable forms other than `${NAME}`, `${NAME:-default}` and `${NAME-default}` (`postgres:${POSTGRES_VERSION:-18}-alpine` is written as it is).
- **Does not start anything.** Run `flisk up` with Flisk core **1.4.26 or later** (`publish` needs it). The importer does not check the core version.
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

