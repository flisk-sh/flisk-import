import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { ImportError } from "./errors.js";
import { type MergedService, toResourceName } from "./merge.js";
import { type ImportPlan, usedManifestPorts } from "./plan.js";
import {
  BYO_PORT_RANGE,
  findProjectRoot,
  IMAGE_PATTERN,
  MIN_SERVICE_PORT,
  SERVICE_MANIFEST_SCHEMA_URL,
  SERVICE_MANIFEST_SCHEMA_VERSION,
  validateName,
} from "./tdk.js";

export type WriteStatus = "create" | "overwrite" | "exists";

export interface WriteItem {
  service: MergedService;
  path: string;
  manifest: Record<string, unknown>;
  status: WriteStatus;
  notes: string[];
}

export interface WritePlan {
  /** Directory holding `.tdk/project.json`, existing or about to be created. */
  projectRoot: string;
  stack: string;
  items: WriteItem[];
  projectConfig?: { path: string; content: string };
  /** Services that could not be written, with the reason. */
  rejected: { name: string; reason: string }[];
}

function existingPort(path: string): number | undefined {
  try {
    const port = JSON.parse(readFileSync(path, "utf8")).port;
    return typeof port === "number" ? port : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Maps merged services onto TDK bring-your-own manifests. This is the only stage that knows the
 * layout `<project>/services/<stack>/<name>/service.json`. Nothing is written here.
 */
/** Images that serve a protocol other than HTTP. Matched against the image name, not its tag. */
const NON_HTTP_IMAGE =
  /(^|\/)(postgres|mysql|mariadb|mongo|mongodb|redis|valkey|memcached|minio|mailpit|mailhog|rabbitmq|kafka|zookeeper|elasticsearch|opensearch|openssh-server)(:|@|$)/i;

export function planWrites(plan: ImportPlan, force: boolean): WritePlan {
  const projectRoot = findProjectRoot(plan.root) ?? plan.root;
  const stack = toResourceName(basename(plan.root));
  const stackCheck = validateName("Stack name", stack);
  if (!stackCheck.valid) {
    throw new ImportError(`Cannot derive a stack name from "${basename(plan.root)}"`, [
      "Run import from a directory whose name has letters or digits",
    ]);
  }
  const servicesDir = join(projectRoot, "services");
  const projectConfigPath = join(projectRoot, ".tdk", "project.json");
  const projectConfig = existsSync(projectConfigPath)
    ? undefined
    : {
        path: projectConfigPath,
        content: `${JSON.stringify(
          {
            version: "1.0",
            project: { name: basename(projectRoot), version: "1.0.0" },
            phases: {
              pre_alpha: {
                name: "Pre-Alpha",
                description: "TDK proxy and imported Compose services",
                enabledStacks: ["proxy", stack],
              },
              alpha: { name: "Alpha", description: "", enabledStacks: [] },
              beta: { name: "Beta", description: "", enabledStacks: [] },
              out_of_scope: { name: "Out of Scope", description: "", enabledStacks: [] },
            },
            optional_infra: {
              monitoring: false,
              elk: false,
              debezium: false,
              golden_image: false,
              verdaccio: false,
            },
            discovery: { paths: ["services/*/*"] },
            overrides: {},
          },
          null,
          2,
        )}\n`,
      };
  const used = usedManifestPorts(servicesDir);
  const items: WriteItem[] = [];
  const rejected: WritePlan["rejected"] = [];

  // Reject first, so no written service depends on one that is not written.
  const accepted = plan.services.filter((service) => {
    const check = validateName("Resource name", service.name);
    const reason = !check.valid
      ? (check.error ?? "invalid name")
      : service.dockerfile
        ? undefined
        : !service.image
          ? "Compose gives it neither `image` nor a usable `build`"
          : !IMAGE_PATTERN.test(service.image)
            ? `image "${service.image}" uses Compose variables or characters TDK does not accept; set a literal image in docker-compose.yml, or write this service.json by hand`
            : undefined;
    if (reason) rejected.push({ name: service.name, reason });
    return !reason;
  });
  const names = new Set(accepted.map((s) => s.name));

  for (const service of accepted) {
    const path = resolve(servicesDir, stack, service.name, "service.json");
    const exists = existsSync(path);
    const status: WriteStatus = !exists ? "create" : force ? "overwrite" : "exists";
    const notes: string[] = [];

    // A file this run replaces does not count against itself; a kept one keeps its port.
    if (status === "overwrite") used.delete(path);
    const keep = status === "overwrite" ? existingPort(path) : undefined;
    const isPrivate = service.exposeViaProxy === false;
    const taken = new Set(used.values());
    const free = (p: number) => p >= BYO_PORT_RANGE.min && p <= BYO_PORT_RANGE.max && !taken.has(p);
    let port: number | undefined;
    if (status === "exists") {
      // Never written, so no port is needed; keep the one on disk for the plan.
      port = existingPort(path) ?? BYO_PORT_RANGE.min;
    } else if (service.port !== undefined && free(service.port)) {
      // The schema accepts this port for bring-your-own and no other service in the project uses it.
      port = service.port;
    } else if (keep !== undefined && free(keep)) {
      port = keep;
    } else {
      for (let p = BYO_PORT_RANGE.min; p <= BYO_PORT_RANGE.max; p++) {
        if (free(p)) {
          port = p;
          break;
        }
      }
      if (service.port !== undefined && port !== undefined)
        notes.push(
          `Compose port ${service.port} is outside ${BYO_PORT_RANGE.label} or already used; assigned ${port}. The container must listen on $PORT (${port}) or it will not answer`,
        );
    }
    if (port === undefined) {
      rejected.push({ name: service.name, reason: `no free port in ${BYO_PORT_RANGE.label}` });
      continue;
    }
    if (status !== "exists") used.set(path, port);

    const dependsOn = service.dependsOn.filter((d) => d !== service.name && names.has(d));
    const dropped = service.dependsOn.filter((d) => d !== service.name && !names.has(d));
    if (dropped.length)
      notes.push(`dependsOn not written, not in this import: ${dropped.join(", ")}`);
    // Infrastructure images and one-shot jobs do not serve HTTP, so an assumed "/" would only
    // fail the probe. Leave the path out; the runtime then skips the HTTP probe.
    const nonHttp =
      service.kind === "job" || (service.image !== undefined && NON_HTTP_IMAGE.test(service.image));
    const healthCheckPath = isPrivate || nonHttp ? undefined : (service.healthCheckPath ?? "/");
    if (nonHttp && !isPrivate)
      notes.push("no health path: the service does not serve HTTP (non-HTTP image or job)");
    if (!isPrivate && !nonHttp && !service.healthCheckPath)
      notes.push(
        "health path / is assumed: Compose has no HTTP healthcheck URL. Traefik routes only while it answers 2xx or 3xx",
      );
    if (service.envKeys.length)
      notes.push("environment values are not written; put them in the project .env");

    // With both, Compose builds and tags the result as `image`; TDK pulls `image` and skips the build.
    const source: Record<string, string> = service.dockerfile
      ? {
          buildContext:
            relative(dirname(path), resolve(plan.root, service.dir)).split("\\").join("/") || ".",
          dockerfile: service.dockerfile,
        }
      : { image: service.image as string };
    const manifest: Record<string, unknown> = {
      $schema: SERVICE_MANIFEST_SCHEMA_URL,
      schemaVersion: SERVICE_MANIFEST_SCHEMA_VERSION,
      appName: service.name,
      appType: "bring-your-own",
      stack,
      port,
      ...(healthCheckPath ? { healthCheckPath } : {}),
      ...source,
      ...(isPrivate ? { exposeViaProxy: false } : {}),
      ...(dependsOn.length ? { dependsOn } : {}),
    };
    items.push({ service, path, manifest, status, notes });
  }
  return { projectRoot, stack, items, projectConfig, rejected };
}

export function applyWrites(writes: WritePlan): WriteItem[] {
  const written: WriteItem[] = [];
  if (writes.projectConfig) {
    mkdirSync(dirname(writes.projectConfig.path), { recursive: true });
    writeFileSync(writes.projectConfig.path, writes.projectConfig.content, { flag: "wx" });
  }
  for (const item of writes.items) {
    if (item.status === "exists") continue;
    mkdirSync(dirname(item.path), { recursive: true });
    writeFileSync(item.path, `${JSON.stringify(item.manifest, null, 2)}\n`);
    written.push(item);
  }
  return written;
}

export function manifestRelPath(plan: ImportPlan, item: WriteItem): string {
  return relative(plan.root, item.path).split("\\").join("/");
}
