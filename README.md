# tdk import

Import the services in a repo's root `docker-compose.yml` into [TDK](https://github.com/flisk-sh/flisk) as `service.json` files. This is the Compose first tier of flisk-sh/flisk#511.

```bash
tdk import . --dry-run     # plan only
tdk import .               # plan, then ask before writing
tdk import . --yes         # write service.json files and project setup
```

## What to expect

- **Reads one file:** the root `docker-compose.yml`. Not `compose.yaml`, override files, nested Compose files, Dockerfiles on their own, `package.json`, or Procfiles.
- **Writes:** one bring-your-own `service.json` per Compose service, plus `.tdk/project.json` if the repo is not a TDK project yet. It never edits the Compose file or overwrites a `service.json` without `--force`.
- **Keeps:** the build context and Dockerfile (or the image), the container port, `depends_on`, and an HTTP health path. Databases and brokers are private, with no proxy route.
- **Drops, and says so:** env values, volumes, `command`, `env_file` and every other untranslated key; services with `profiles`, `extends`, an out-of-tree build or a `${VAR}` image.
- **Does not start anything.** Put env values in `.env`, then run `tdk up` with TDK core **1.3.145 or later**. The importer does not check the core version.
- **Exit codes:** `0` when the plan succeeds (`--dry-run`, files written, or all `service.json` files already exist), `1` when no root `docker-compose.yml` or mappable service is found, and `2` when the write prompt is declined or closed without an answer (`Nothing written.`).

See [docs/import.md](docs/import.md) for the full mapping and limits. `tdk import` is the core CLI command backed by this package.

```bash
bun install && bun run build && bun run test
```
