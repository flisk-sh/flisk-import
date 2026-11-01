import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { ImportError } from "./errors.js";
import {
  BYO_PORT_RANGE,
  defaultProjectConfig,
  findProjectRoot,
  IMAGE_PATTERN,
  SERVICE_MANIFEST_SCHEMA_URL,
  SERVICE_MANIFEST_SCHEMA_VERSION,
  validateName,
} from "./flisk.js";
import { type MergedService, toResourceName } from "./merge.js";
import { type ImportPlan, usedManifestPorts } from "./plan.js";

export type WriteStatus = "create" | "overwrite" | "exists";

export interface WriteItem {
  service: MergedService;
  path: string;
  manifest: Record<string, unknown>;
  /** Files written next to service.json, such as the Dockerfile that carries a Compose `command`. */
  files: { path: string; content: string }[];
  status: WriteStatus;
  notes: string[];
}

export interface WritePlan {
  /** Directory holding `.flisk/project.json`, existing or about to be created. */
  projectRoot: string;
  stack: string;
  items: WriteItem[];
  projectConfig?: { path: string; content: string };
  /** Services that could not be written, with the reason. */
  rejected: { name: string; reason: string }[];
  /** Values from docker-compose.yml to append to the project .env (gitignored); keys it already has are kept. */
  env: { path: string; add: Record<string, string> };
}

/** Secret names the service schema accepts (`secrets.required`). */
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
/** Names that may hold a credential whatever their value looks like; these always stay secrets. */
const CREDENTIAL_NAME =
  /PASS|SECRET|TOKEN|KEY|PRIVATE|CREDENTIAL|AUTH|HMAC|SALT|CERT|SESSION|COOKIE/i;

/**
 * Whether a literal Compose value cannot be a secret, so it may be committed in service.json `env`: a number, true or false,
 * or the address of another service in this import (a URL or host:port with no user, password, query or fragment).
 */
function isPlainValue(value: string, serviceHosts: Set<string>): boolean {
  if (/^-?\d+(\.\d+)?$/.test(value) || /^(true|false)$/i.test(value)) return true;
  const hostPort = value.match(/^([a-z0-9][a-z0-9._-]*):(\d{1,5})$/);
  if (hostPort) return serviceHosts.has(hostPort[1] as string);
  try {
    const url = new URL(value);
    return (
      serviceHosts.has(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^[A-Za-z0-9._~/-]*$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function readEnvKeys(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  return new Set(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1])
      .filter((key): key is string => key !== undefined),
  );
}

/** A .env value, quoted when it holds characters a dotenv parser would split or strip. */
function envLine(key: string, value: string): string {
  return /^[A-Za-z0-9_./:@+-]*$/.test(value)
    ? `${key}=${value}`
    : `${key}=${JSON.stringify(value)}`;
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
 * Maps merged services onto Flisk bring-your-own manifests. This is the only stage that knows the
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
  const projectConfigPath = join(projectRoot, ".flisk", "project.json");
  const projectConfig = existsSync(projectConfigPath)
    ? undefined
    : {
        path: projectConfigPath,
        content: `${JSON.stringify(
          defaultProjectConfig(projectRoot, {
            description: "Flisk proxy and imported Compose services",
            enabledStacks: ["proxy", stack],
          }),
          null,
          2,
        )}\n`,
      };
  const envPath = join(projectRoot, ".env");
  const envKept = readEnvKeys(envPath);
  const envAdd: Record<string, string> = {};
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
            ? `image "${service.image}" uses Compose variables or characters Flisk does not accept; set a literal image in docker-compose.yml, or write this service.json by hand`
            : undefined;
    if (reason) rejected.push({ name: service.name, reason });
    return !reason;
  });
  const names = new Set(accepted.map((s) => s.name));
  // Hostnames other services use for these: the resource name, which stays the container hostname, and the Compose name.
  const serviceHosts = new Set(
    plan.services.flatMap((s) => (s.originalName ? [s.name, s.originalName] : [s.name])),
  );

  for (const service of accepted) {
    const path = resolve(servicesDir, stack, service.name, "service.json");
    const exists = existsSync(path);
    const status: WriteStatus = !exists ? "create" : force ? "overwrite" : "exists";
    const notes: string[] = [];
    if (service.originalName && service.originalName !== service.name)
      notes.push(
        `renamed from "${service.originalName}" (Compose names must be lowercase kebab-case)`,
      );

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
    } else if (service.port !== undefined) {
      // A bring-your-own port is the port inside its own container (Traefik reaches it on the stack
      // network; nothing is published on the host), so the Compose port is kept as written.
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
    }
    if (status !== "exists" && service.port === undefined && !isPrivate && port !== undefined)
      notes.push(
        `port ${port} assigned: Compose gives no single container port; the container must listen on $PORT (${port})`,
      );
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
        "health path / is assumed: no HTTP health path could be read from Compose. Traefik routes only while it answers 2xx or 3xx",
      );
    // A probe command is the only way to describe a non-HTTP check; a routed service keeps its HTTP path.
    const healthCheck =
      service.healthCheck && !(healthCheckPath && service.healthCheckPath)
        ? service.healthCheck
        : undefined;
    // Values that cannot be secrets (numbers, booleans, another service's address, pure ${VAR} references) go into the
    // committed service.json `env` (Flisk 1.4.24). Every other name is a secret: Flisk injects it from the gitignored .env.
    const validNames = service.envKeys.filter((key) => ENV_NAME.test(key));
    const env: Record<string, string> = {};
    for (const key of validNames) {
      if (CREDENTIAL_NAME.test(key)) continue;
      const literal = service.env[key];
      const reference = service.envRefs[key];
      if (literal !== undefined && isPlainValue(literal, serviceHosts)) env[key] = literal;
      else if (literal === undefined && reference !== undefined) env[key] = reference;
    }
    const referenced = [
      ...new Set(
        Object.values(env).flatMap((value) =>
          [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:?-)?/g)]
            .filter((m) => !m[2])
            .map((m) => m[1] as string),
        ),
      ),
    ].filter((name) => !envKept.has(name) && !(name in envAdd));
    if (referenced.length)
      notes.push(`env reads ${referenced.join(", ")} from the project .env; add them there`);
    const secretNames = validNames.filter((key) => !(key in env));
    const skippedNames = service.envKeys.filter((key) => !ENV_NAME.test(key));
    if (skippedNames.length)
      notes.push(
        `environment names not written (Flisk accepts A-Z, 0-9 and _): ${skippedNames.join(", ")}`,
      );
    const missing: string[] = [];
    for (const key of secretNames) {
      const value = service.env[key];
      if (envKept.has(key) || key in envAdd) continue;
      if (value === undefined) missing.push(key);
      else envAdd[key] = value;
    }
    if (missing.length)
      notes.push(
        `no literal value in docker-compose.yml for ${missing.join(", ")}; add it to the project .env`,
      );
    if (service.dockerfile && service.image)
      notes.push(
        `image "${service.image}" is not written: with build and image, Flisk builds from ${service.dockerfile} and does not pull the tag`,
      );

    // With both build and image, Compose builds the Dockerfile and tags the result as `image`.
    // Omit `image` from service.json so Flisk builds from the Dockerfile instead of pulling the tag.
    // Flisk has no container `command`, so a Compose `command` on an image becomes the CMD of a one-line Dockerfile.
    const files: WriteItem["files"] = [];
    const wrapWithCommand =
      !service.dockerfile &&
      service.image &&
      (service.containerCommand || service.containerEntrypoint);
    if (wrapWithCommand) {
      files.push({
        path: resolve(dirname(path), "Dockerfile"),
        content: `# From the Compose \`command\` of this service (flisk import). Flisk sets no container command, so it lives here.\nFROM ${service.image}\n${service.containerEntrypoint ? `ENTRYPOINT ${JSON.stringify(service.containerEntrypoint)}\n` : ""}${service.containerCommand ? `CMD ${JSON.stringify(service.containerCommand)}\n` : ""}`,
      });
      notes.push(
        `${service.containerEntrypoint ? "entrypoint" : "command"} ${JSON.stringify(service.containerEntrypoint ?? service.containerCommand)} is written to a Dockerfile on ${service.image}`,
      );
    } else if (service.dockerfile && (service.containerCommand || service.containerEntrypoint)) {
      notes.push(
        `command/entrypoint not written: set it as CMD/ENTRYPOINT in ${service.dockerfile}`,
      );
    }
    const source: Record<string, string> = wrapWithCommand
      ? { buildContext: ".", dockerfile: "Dockerfile" }
      : service.dockerfile
        ? {
            buildContext:
              relative(dirname(path), resolve(plan.root, service.dir)).split("\\").join("/") || ".",
            dockerfile: service.dockerfile,
          }
        : { image: service.image as string };
    // A sidecar shares another written service's network; one whose host is not written stays a normal service.
    const sidecarOf =
      service.sidecarOf && service.sidecarOf !== service.name && names.has(service.sidecarOf)
        ? service.sidecarOf
        : undefined;
    if (service.sidecarOf && !sidecarOf)
      notes.push(`network_mode not written: "${service.sidecarOf}" is not in this import`);
    const extraPorts = sidecarOf ? [] : (service.extraPorts ?? []);
    if (sidecarOf && service.extraPorts?.length)
      notes.push(
        `ports not written: a sidecar has none of its own; publish them on "${sidecarOf}"`,
      );
    if (extraPorts.length)
      notes.push(
        `published on 127.0.0.1 only: ${extraPorts.map((p) => `${p.hostPort ?? p.port}->${p.port}/${p.protocol ?? "tcp"}`).join(", ")}`,
      );
    // Bind mounts are relative to the service directory in service.json, and must stay inside the project.
    const serviceDir = dirname(path);
    const volumes = (service.volumes ?? []).flatMap((volume) => {
      if (!volume.bind) return [volume];
      const absolute = resolve(plan.root, volume.source);
      const fromProject = relative(projectRoot, absolute).split("\\").join("/");
      if (fromProject === ".." || fromProject.startsWith("../")) {
        notes.push(
          `volume ${volume.source}:${volume.target} not written: it is outside the project`,
        );
        return [];
      }
      const rel = relative(serviceDir, absolute).split("\\").join("/") || ".";
      return [{ ...volume, source: rel.startsWith(".") ? rel : `./${rel}` }];
    });
    const manifest: Record<string, unknown> = {
      $schema: SERVICE_MANIFEST_SCHEMA_URL,
      schemaVersion: SERVICE_MANIFEST_SCHEMA_VERSION,
      appName: service.name,
      appType: "bring-your-own",
      stack,
      port,
      ...(healthCheckPath ? { healthCheckPath } : {}),
      ...(healthCheck ? { healthCheck } : {}),
      ...source,
      ...(isPrivate ? { exposeViaProxy: false } : {}),
      ...(dependsOn.length ? { dependsOn } : {}),
      ...(Object.keys(env).length
        ? { env: Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) }
        : {}),
      ...(secretNames.length ? { secrets: { required: secretNames } } : {}),
      ...(service.restart ? { restart: service.restart } : {}),
      ...(service.container ? { container: service.container } : {}),
      ...(service.models ? { models: service.models } : {}),
      ...(extraPorts.length ? { extraPorts } : {}),
      ...(sidecarOf ? { sidecarOf } : {}),
      ...(volumes.length
        ? {
            // `name` keeps the Docker volume the Compose install already has, so its data is used with no copy.
            volumes: volumes.map(({ source, target, readOnly, name }) => ({
              source,
              target,
              ...(readOnly ? { readOnly } : {}),
              ...(name ? { name } : {}),
            })),
          }
        : {}),
    };
    items.push({ service, path, manifest, files, status, notes });
  }
  return {
    projectRoot,
    stack,
    items,
    projectConfig,
    rejected,
    env: { path: envPath, add: envAdd },
  };
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
    for (const file of item.files) writeFileSync(file.path, file.content);
    written.push(item);
  }
  const keys = Object.keys(writes.env.add);
  if (keys.length) {
    const existing = existsSync(writes.env.path) ? readFileSync(writes.env.path, "utf8") : "";
    const lines = keys.map((key) => envLine(key, writes.env.add[key] as string));
    const block = `${existing && !existing.endsWith("\n") ? "\n" : ""}# From docker-compose.yml (flisk import)\n${lines.join("\n")}\n`;
    writeFileSync(writes.env.path, existing + block);
    ensureGitignored(writes.projectRoot, ".env");
  }
  return written;
}

export function manifestRelPath(plan: ImportPlan, item: WriteItem): string {
  return relative(plan.root, item.path).split("\\").join("/");
}

/** Keeps the project .env out of git: it now holds values copied from docker-compose.yml. */
function ensureGitignored(projectRoot: string, entry: string): void {
  const path = join(projectRoot, ".gitignore");
  const content = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (content.split(/\r?\n/).some((line) => line.trim() === entry || line.trim() === `/${entry}`))
    return;
  writeFileSync(path, `${content}${content && !content.endsWith("\n") ? "\n" : ""}${entry}\n`);
}
