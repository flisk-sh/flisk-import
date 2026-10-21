## Why

`import-repo` shipped a general framework: a directory walk, four detectors (Compose, Dockerfile, package.json, Procfile), and a merge between them. In practice the merge and the unsupported-infrastructure safeguards were the expensive, least-verified part, and only the Compose path was checked against a real public repo. The first tier of flisk#511 is the root `docker-compose.yml`, so this change narrows the importer to that one file and makes it produce a project `tdk up` can start.

## What Changes

- **BREAKING** `flisk-import` reads exactly `<dir>/docker-compose.yml`. It no longer walks the tree, honors `.gitignore`, or reads Dockerfile, `package.json`, or Procfile. A missing root file is an error that says so.
- **BREAKING** Remove `--only`. Compose is the only active detector.
- Compose detection additionally carries stack membership, `depends_on`, the original `build.context` and `build.dockerfile`, an HTTP health path from `healthcheck.test`, and whether the service should be exposed through the proxy.
- Services on common non-HTTP ports (Postgres, MySQL, Redis, Mongo, RabbitMQ, Kafka, Elasticsearch, Memcached) are written as private bring-your-own services with no health path and no proxy route.
- With `--yes` (or confirmation), also write a minimal `.tdk/project.json` when none exists, enabling the proxy and the imported stack.
- A Compose port is kept when it is a valid unprivileged port, instead of being replaced by a TDK-assigned one. Services of different containers may share a port.
- Document the narrow scope; `profiles` and `extends` are still reported as skipped.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `repo-import`: scan scope, detector set, merge, write, and report requirements change as listed in the delta spec.

## Impact

- `src/cli.ts`, `src/plan.ts`, `src/write.ts`, `src/merge.ts`, `src/detectors/compose.ts`, `src/detectors/index.ts`, `src/format.ts`, `src/types.ts`.
- Dockerfile, package.json, and Procfile detectors are no longer registered. Their code and the `import-repo` tasks that built them remain history; re-adding one is a later change against the same registry.
- Docs: `README.md` and `docs/import.md` rewritten for the narrow scope.
- Related: flisk#511 (umbrella). The PR stays a draft until the core bootstrap problem (`.tdk/.tdk-out/Tiltfile` missing after `tdk up`) is fixed and two public repos run successfully.
