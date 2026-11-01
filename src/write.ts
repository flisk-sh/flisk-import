import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { composeTemplateText, isComposeExpression, projectNameOf } from "./detectors/compose.js";
import { ImportError } from "./errors.js";
import {
  BYO_PORT_RANGE,
  defaultProjectConfig,
  findProjectRoot,
  IMAGE_PATTERN,
  NETWORK_ALIAS,
  SERVICE_MANIFEST_SCHEMA_URL,
  SERVICE_MANIFEST_SCHEMA_VERSION,
  validateName,
} from "./flisk.js";
import { type MergedService, toResourceName } from "./merge.js";
import { type ImportPlan, usedManifestPorts } from "./plan.js";
import type { ExtraPort } from "./types.js";

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
  /**
   * The existing .flisk/project.json with `composeProjectNames.<stack>` added: the project name `docker compose` gave
   * this Compose file, so an export (flisk-export compose) keeps its container and volume names.
   */
  projectConfigUpdate?: { path: string; content: string };
  /** That Compose project name, when one could be read. */
  composeProjectName?: string;
  /** Services that could not be written, with the reason. */
  rejected: { name: string; reason: string }[];
  /**
   * Values from docker-compose.yml to append to a local env file; keys it already has are kept. That is the project
   * .env, unless git tracks it (a Symfony-style repo commits its .env defaults): then `.env.local` when git already
   * ignores it, else `.flisk/.env.import`. `gitignore` is the entry to add to .gitignore, if any; `tracked` names the
   * tracked .env that is left alone.
   */
  env: { path: string; add: Record<string, string>; gitignore?: string; tracked?: string };
}

/** Secret names the service schema accepts (`secrets.required`). */
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
/** Names that may hold a credential whatever their value looks like; these always stay secrets. */
const CREDENTIAL_NAME =
  /PASS|SECRET|TOKEN|KEY|PRIVATE|CREDENTIAL|AUTH|HMAC|SALT|CERT|SESSION|COOKIE/i;

/**
 * Whether a literal value may hold a credential although its name does not say so: a URL or `user:pass@host` with a
 * user or password, a query parameter named like a credential, a PEM block, a long random-looking token, or a value
 * that says it is one (SECRET, TOKEN, PASSWORD).
 */
/** Query parameters that carry a credential (`?token=`, `?api_key=`, `&sig=`); `authSource` and the like do not. */
const CREDENTIAL_QUERY =
  /token|secret|pass(word|wd)?$|api[_-]?key|^key$|^sig(nature)?$|access[_-]?key/i;

function looksSecret(value: string): boolean {
  if (/^[^\s:@/]+:[^\s@/]+@/.test(value) || value.includes("-----BEGIN")) return true;
  if (/SECRET|TOKEN|PASSWORD|PASSWD/i.test(value)) return true;
  if (/^[A-Za-z0-9+/_=.-]{32,}$/.test(value) && /[0-9]/.test(value) && /[A-Za-z]/.test(value))
    return true;
  if (!value.includes("://")) return false;
  try {
    const url = new URL(value);
    return (
      Boolean(url.username || url.password) ||
      [...url.searchParams.keys()].some((key) => CREDENTIAL_QUERY.test(key))
    );
  } catch {
    return /:\/\/[^/\s]*@/.test(value);
  }
}

/**
 * `ARG` lines for the Compose variables in an image, so `FROM postgres:${POSTGRES_VERSION:-18}-alpine` can use them:
 * Docker substitutes only build arguments declared before FROM. The default is the expression's.
 */
function buildArgLines(image: string): string {
  const args = new Map<string, string | undefined>();
  for (const m of image.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}/g))
    if (!args.has(m[1] as string)) args.set(m[1] as string, m[2]);
  return [...args]
    .map(([name, value]) => (value === undefined ? `ARG ${name}\n` : `ARG ${name}=${value}\n`))
    .join("");
}

/** `POSTGRES_PASSWORD_FILE=/run/secrets/pg`: the path of a mounted secret file, which is not a secret itself. */
function isSecretFilePath(key: string, value: string): boolean {
  return /_FILE$/.test(key) && /^\/[A-Za-z0-9_./-]+$/.test(value);
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
  const composeProjectName = composeProjectNameOf(plan);
  const composeNames = composeProjectName
    ? { composeProjectNames: { [stack]: composeProjectName } }
    : {};
  const projectConfig = existsSync(projectConfigPath)
    ? undefined
    : {
        path: projectConfigPath,
        content: `${JSON.stringify(
          {
            ...defaultProjectConfig(projectRoot, {
              description: "Flisk proxy and imported Compose services",
              enabledStacks: ["proxy", stack],
            }),
            ...composeNames,
          },
          null,
          2,
        )}\n`,
      };
  const projectConfigUpdate = projectConfig
    ? undefined
    : withComposeProjectName(projectConfigPath, stack, composeProjectName);
  const envTarget = localEnvFile(projectRoot);
  const envPath = envTarget.path;
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
            ? `image "${service.image}" has characters Flisk does not accept (Compose variables may only be \${NAME}, \${NAME:-default} or \${NAME-default}); fix it in docker-compose.yml, or write this service.json by hand`
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
    const healthOff = service.healthCheck === false;
    const healthCheckPath =
      isPrivate || nonHttp || healthOff ? undefined : (service.healthCheckPath ?? "/");
    if (healthOff) notes.push("healthCheck: false: Compose turns the healthcheck off");
    else if (nonHttp && !isPrivate)
      notes.push("no health path: the service does not serve HTTP (non-HTTP image or job)");
    if (!isPrivate && !nonHttp && !healthOff && !service.healthCheckPath)
      notes.push(
        "health path / is assumed: no HTTP health path could be read from Compose. Traefik routes only while it answers 2xx or 3xx",
      );
    // The Compose healthcheck stays as healthCheck.command (with its interval, timeout, retries and start period) even
    // when an HTTP path was read too, so an exported docker-compose.yml keeps it and `condition: service_healthy` holds.
    const healthCheck = service.healthCheck;
    if (healthCheck && healthCheckPath && service.healthCheckPath)
      notes.push(
        `healthCheck.command ${JSON.stringify(healthCheck.command)} is kept as Compose wrote it; Flisk probes with it instead of ${healthCheckPath}`,
      );
    // What goes into the committed service.json `env` (Flisk 1.4.24): a pure Compose expression (`${X}`, `${X:-default}`,
    // `${A:-${B:-file}}`) as it is, whatever its name, since its default is already committed in the Compose file; and
    // a literal whose name does not look like a credential and whose value does not hold one. Every other name is a
    // secret: Flisk injects it from the gitignored .env, which gets the literal value.
    const validNames = service.envKeys.filter((key) => ENV_NAME.test(key));
    const env: Record<string, string> = {};
    for (const key of validNames) {
      const literal = service.env[key];
      const reference = service.envRefs[key];
      if (literal === undefined && reference !== undefined) {
        // A pure expression is committed whatever its name; one mixed with literal text only when that text, with
        // the expressions taken out, could not be a credential (`mongodb://${USER}:${PASSWORD:-x}@db/app` can).
        const text = composeTemplateText(reference) ?? "";
        if (isComposeExpression(reference) || (!CREDENTIAL_NAME.test(key) && !looksSecret(text)))
          env[key] = reference;
      } else if (literal !== undefined && isSecretFilePath(key, literal)) env[key] = literal;
      else if (literal !== undefined && !CREDENTIAL_NAME.test(key) && !looksSecret(literal))
        env[key] = literal;
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
        content: `# From the Compose \`command\` of this service (flisk import). Flisk sets no container command, so it lives here.\n${buildArgLines(service.image as string)}FROM ${service.image}\n${service.containerEntrypoint ? `ENTRYPOINT ${JSON.stringify(service.containerEntrypoint)}\n` : ""}${service.containerCommand ? `CMD ${JSON.stringify(service.containerCommand)}\n` : ""}`,
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
    // A renamed service keeps its Compose name as a network alias, so `http://lychee_api:8000` or `DB_HOST=lychee_db`
    // in another service still resolves. A sidecar has no network of its own, so it gets no aliases.
    const renamed =
      service.originalName && service.originalName !== service.name
        ? service.originalName
        : undefined;
    const keepRenamed = renamed !== undefined && NETWORK_ALIAS.test(renamed);
    if (renamed && !keepRenamed)
      notes.push(`"${renamed}" is not kept as a network alias: it is not a DNS name`);
    const aliases = [
      ...new Set([...(service.container?.networkAliases ?? []), ...(keepRenamed ? [renamed] : [])]),
    ].filter((alias) => alias !== service.name);
    let container = service.container;
    if (sidecarOf) {
      if (aliases.length)
        notes.push(
          `network aliases not written (${aliases.join(", ")}): a sidecar shares "${sidecarOf}"'s network`,
        );
      if (container?.networkAliases) {
        const { networkAliases: _aliases, ...rest } = container;
        container = Object.keys(rest).length ? rest : undefined;
      }
    } else if (aliases.length) {
      container = { ...(container ?? {}), networkAliases: aliases };
      if (keepRenamed)
        notes.push(
          `network alias "${renamed}" keeps the Compose name, so other services that call it by that name still reach it`,
        );
    }
    const extraPorts = sidecarOf ? [] : (service.extraPorts ?? []);
    if (sidecarOf && service.extraPorts?.length)
      notes.push(
        `ports not written: a sidecar has none of its own; publish them on "${sidecarOf}"`,
      );
    const portText = (p: ExtraPort) =>
      `${p.publish ?? p.hostPort ?? p.port}->${p.port}/${p.protocol ?? "tcp"}`;
    const loopback = extraPorts.filter((p) => !p.bind && !p.publish);
    const everywhere = extraPorts.filter((p) => p.bind === "0.0.0.0");
    const fromCompose = extraPorts.filter((p) => p.publish);
    if (loopback.length)
      notes.push(`published on 127.0.0.1 only: ${loopback.map(portText).join(", ")}`);
    if (everywhere.length)
      notes.push(
        `published on every interface, as in Compose: ${everywhere.map(portText).join(", ")} (flisk doctor lists these)`,
      );
    if (fromCompose.length)
      notes.push(
        `published as Compose wrote the host side: ${fromCompose.map(portText).join(", ")}`,
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
    // env_file paths are relative to the service directory in service.json, and must stay inside the project.
    // With the project .env tracked by git, secrets live in another local file, which Flisk then reads as envFile.
    const localEnv =
      envTarget.git.tracked && secretNames.length
        ? [relative(dirname(path), envPath).split("\\").join("/")]
        : [];
    const envFile = (service.envFile ?? []).flatMap((file) => {
      const absolute = resolve(plan.root, file);
      const fromProject = relative(projectRoot, absolute).split("\\").join("/");
      if (fromProject === ".." || fromProject.startsWith("../")) {
        notes.push(`env_file ${file} not written: it is outside the project`);
        return [];
      }
      return [relative(serviceDir, absolute).split("\\").join("/")];
    });
    const manifest: Record<string, unknown> = {
      $schema: SERVICE_MANIFEST_SCHEMA_URL,
      schemaVersion: SERVICE_MANIFEST_SCHEMA_VERSION,
      appName: service.name,
      appType: "bring-your-own",
      stack,
      port,
      ...(healthCheckPath ? { healthCheckPath } : {}),
      ...(healthCheck !== undefined ? { healthCheck } : {}),
      ...source,
      ...(isPrivate ? { exposeViaProxy: false } : {}),
      ...(dependsOn.length ? { dependsOn } : {}),
      ...(Object.keys(env).length
        ? { env: Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) }
        : {}),
      ...(secretNames.length ? { secrets: { required: secretNames } } : {}),
      ...(service.restart ? { restart: service.restart } : {}),
      ...(container ? { container } : {}),
      ...(service.models ? { models: service.models } : {}),
      ...(service.profiles ? { profiles: service.profiles } : {}),
      ...(envFile.length || localEnv.length
        ? { envFile: [...new Set([...envFile, ...localEnv])] }
        : {}),
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
    ...(projectConfigUpdate ? { projectConfigUpdate } : {}),
    ...(composeProjectName ? { composeProjectName } : {}),
    rejected,
    env: { path: envPath, add: envAdd, ...envTarget.git },
  };
}

export function applyWrites(writes: WritePlan): WriteItem[] {
  const written: WriteItem[] = [];
  if (writes.projectConfig) {
    mkdirSync(dirname(writes.projectConfig.path), { recursive: true });
    writeFileSync(writes.projectConfig.path, writes.projectConfig.content, { flag: "wx" });
  }
  if (writes.projectConfigUpdate)
    writeFileSync(writes.projectConfigUpdate.path, writes.projectConfigUpdate.content);
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
    mkdirSync(dirname(writes.env.path), { recursive: true });
    if (writes.env.gitignore) ensureGitignored(writes.projectRoot, writes.env.gitignore);
  }
  return written;
}

export function manifestRelPath(plan: ImportPlan, item: WriteItem): string {
  return relative(plan.root, item.path).split("\\").join("/");
}

/** The project name `docker compose` gives the imported Compose file: its `name:`, else its folder's name. */
function composeProjectNameOf(plan: ImportPlan): string | undefined {
  const file = plan.files.find((f) => /^(docker-)?compose\.ya?ml$/.test(f));
  if (!file) return undefined;
  const absPath = join(plan.root, file);
  try {
    return projectNameOf(parseYaml(readFileSync(absPath, "utf8"), { merge: true }), absPath);
  } catch {
    return undefined;
  }
}

/** An existing project.json with `composeProjectNames.<stack>` set, or undefined when it has it already or is unreadable. */
function withComposeProjectName(
  path: string,
  stack: string,
  name: string | undefined,
): { path: string; content: string } | undefined {
  if (!name) return undefined;
  try {
    const config = JSON.parse(readFileSync(path, "utf8"));
    if (typeof config !== "object" || config === null || Array.isArray(config)) return undefined;
    const names =
      typeof config.composeProjectNames === "object" && config.composeProjectNames !== null
        ? config.composeProjectNames
        : {};
    if (names[stack] === name) return undefined;
    return {
      path,
      content: `${JSON.stringify({ ...config, composeProjectNames: { ...names, [stack]: name } }, null, 2)}\n`,
    };
  } catch {
    return undefined;
  }
}

/** Whether git in `root` tracks `file` (false outside a git repo, or without git). */
function gitTracks(root: string, file: string): boolean {
  try {
    execFileSync("git", ["-C", root, "ls-files", "--error-unmatch", file], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Whether git in `root` ignores `file` (false outside a git repo, or without git). */
function gitIgnores(root: string, file: string): boolean {
  try {
    execFileSync("git", ["-C", root, "check-ignore", "-q", file], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * The local file that gets values copied from docker-compose.yml: the project .env, never one git tracks. A tracked
 * .env is left as it is, and not added to .gitignore.
 */
function localEnvFile(projectRoot: string): {
  path: string;
  git: { gitignore?: string; tracked?: string };
} {
  if (!gitTracks(projectRoot, ".env"))
    return { path: join(projectRoot, ".env"), git: { gitignore: ".env" } };
  if (gitIgnores(projectRoot, ".env.local") && !gitTracks(projectRoot, ".env.local"))
    return { path: join(projectRoot, ".env.local"), git: { tracked: ".env" } };
  return {
    path: join(projectRoot, ".flisk", ".env.import"),
    git: {
      tracked: ".env",
      ...(gitIgnores(projectRoot, ".flisk/.env.import") ? {} : { gitignore: ".flisk/.env.import" }),
    },
  };
}

/** Keeps the local env file out of git: it now holds values copied from docker-compose.yml. */
function ensureGitignored(projectRoot: string, entry: string): void {
  const path = join(projectRoot, ".gitignore");
  const content = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (content.split(/\r?\n/).some((line) => line.trim() === entry || line.trim() === `/${entry}`))
    return;
  writeFileSync(path, `${content}${content && !content.endsWith("\n") ? "\n" : ""}${entry}\n`);
}
