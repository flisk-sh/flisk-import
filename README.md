# flisk import

Import the services in a repo's root `docker-compose.yml` into [Flisk](https://github.com/flisk-sh/flisk) as `service.json` files. This is the Compose first tier of flisk-sh/flisk#511.

```bash
flisk import . --dry-run     # plan only
flisk import .               # plan, then ask before writing
flisk import . --yes         # write service.json files and project setup
```

## What to expect

- **Reads one file:** the root `docker-compose.yml`. Not `compose.yaml`, override files, nested Compose files, Dockerfiles on their own, `package.json`, or Procfiles.
- **Writes:** one bring-your-own `service.json` per Compose service, plus `.flisk/project.json` if the repo is not a Flisk project yet. It never edits the Compose file or overwrites a `service.json` without `--force`.
- **Keeps:** the build context and Dockerfile (or the image), the container port, `depends_on`, and an HTTP health path. Databases and brokers are private, with no proxy route.
- **Drops, and says so:** env values, volumes, `command`, `env_file` and every other untranslated key; services with `profiles`, `extends`, an out-of-tree build or a `${VAR}` image.
- **Does not start anything.** Put env values in `.env`, then run `flisk up` with Flisk core **1.3.145 or later**. The importer does not check the core version.
- **Exit codes:** `0` when the plan succeeds (`--dry-run`, files written, or all `service.json` files already exist), `1` when no root `docker-compose.yml` or mappable service is found, and `2` when the write prompt is declined or closed without an answer (`Nothing written.`).

See [docs/import.md](docs/import.md) for the full mapping and limits. `flisk import` is the core CLI command backed by this package.

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

