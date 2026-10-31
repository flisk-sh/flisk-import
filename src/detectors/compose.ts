import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path/posix";
import { isAlias, isMap, type Node, parseDocument, visit } from "yaml";
import { HEALTH_CHECK_PATH_PATTERN } from "../flisk.js";
import { registerDetector } from "../registry.js";
import type { Candidate, ContainerOptions, ExtraPort, Skip, VolumeMount } from "../types.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Container-side port of one `ports:` entry, in short or long syntax. */
function containerPort(entry: unknown): number | undefined {
  if (typeof entry === "number") return entry;
  if (isObj(entry)) return typeof entry.target === "number" ? entry.target : undefined;
  if (typeof entry !== "string") return undefined;
  const last = entry.split("/")[0]?.split(":").pop() ?? "";
  const first = last.split("-")[0] ?? "";
  return /^\d+$/.test(first) ? Number.parseInt(first, 10) : undefined;
}

/** Well-known non-HTTP ports: SSH, SMTP, ZooKeeper, MQTT, then databases and brokers. */
const NON_HTTP_PORTS = new Set([
  22, 25, 1883, 2181, 3306, 5432, 5672, 6379, 9092, 9200, 11211, 27017,
]);

/**
 * Service keys this detector translates. Every other key is named in the report: Flisk runs a
 * bring-your-own container without command overrides, env files and the rest.
 * `healthcheck` only contributes an HTTP path; `environment` only contributes names. The runtime keys
 * (capabilities, volumes, network_mode, restart) map onto service.json fields; a value that cannot be
 * carried over is named on its own line instead.
 */
const TRANSLATED_KEYS = new Set([
  "image",
  "build",
  "ports",
  "environment",
  "depends_on",
  "healthcheck",
  "cap_add",
  "cap_drop",
  "init",
  "read_only",
  "user",
  "security_opt",
  "shm_size",
  "network_mode",
  "volumes",
  "restart",
]);

const CAPABILITY = /^[A-Z_]+$/;
const USER = /^[A-Za-z0-9_.:-]+$/;
const SECURITY_OPT = /^[A-Za-z0-9_.:=/-]+$/;
const VOLUME_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const CONTAINER_PATH = /^\/[A-Za-z0-9_./-]*$/;
const HOST_PATH = /^[A-Za-z0-9_./-]+$/;
const RESTART = new Set(["no", "on-failure", "unless-stopped", "always"]);

/** Compose `shm_size` as a size string such as 256mb; a number is bytes. */
function shmSizeOf(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return `${value}b`;
  if (typeof value === "string" && /^[0-9]+([bkmg]b?)?$/i.test(value)) return value;
  return undefined;
}

/** `container` for service.json, and the values that could not be carried over. */
function containerOf(raw: Obj): { container?: ContainerOptions; dropped: string[] } {
  const container: ContainerOptions = {};
  const dropped: string[] = [];
  for (const [key, field] of [
    ["cap_add", "capAdd"],
    ["cap_drop", "capDrop"],
  ] as const) {
    if (raw[key] === undefined) continue;
    const caps = Array.isArray(raw[key]) ? (raw[key] as unknown[]) : [];
    const kept = caps.filter((c): c is string => typeof c === "string" && CAPABILITY.test(c));
    if (kept.length !== caps.length || caps.length === 0) dropped.push(key);
    if (kept.length) container[field] = kept;
  }
  if (raw.init !== undefined) {
    if (typeof raw.init === "boolean") container.init = raw.init;
    else dropped.push("init");
  }
  if (raw.read_only !== undefined) {
    if (typeof raw.read_only === "boolean") container.readOnly = raw.read_only;
    else dropped.push("read_only");
  }
  if (raw.user !== undefined) {
    const user = typeof raw.user === "number" ? String(raw.user) : raw.user;
    if (typeof user === "string" && USER.test(user)) container.user = user;
    else dropped.push("user");
  }
  if (raw.security_opt !== undefined) {
    const opts = Array.isArray(raw.security_opt) ? raw.security_opt : [];
    const kept = opts.filter((o): o is string => typeof o === "string" && SECURITY_OPT.test(o));
    if (kept.length !== opts.length || opts.length === 0) dropped.push("security_opt");
    if (kept.length) container.securityOpt = kept;
  }
  if (raw.shm_size !== undefined) {
    const size = shmSizeOf(raw.shm_size);
    if (size) container.shmSize = size;
    else dropped.push("shm_size");
  }
  return { ...(Object.keys(container).length ? { container } : {}), dropped };
}

/** One published port: container port, host port when Compose names a literal one, and protocol. */
function publishedPort(entry: unknown): ExtraPort | undefined {
  const port = containerPort(entry);
  if (port === undefined) return undefined;
  let host: number | undefined;
  let protocol: "tcp" | "udp" = "tcp";
  if (isObj(entry)) {
    const published =
      typeof entry.published === "string" ? Number(entry.published) : entry.published;
    if (typeof published === "number" && Number.isInteger(published)) host = published;
    if (entry.protocol === "udp") protocol = "udp";
  } else if (typeof entry === "string") {
    const [mapping, proto] = entry.split("/");
    if (proto === "udp") protocol = "udp";
    const parts = (mapping ?? "").split(":");
    const hostPart = parts.length >= 2 ? parts[parts.length - 2] : undefined;
    if (hostPart && /^\d+$/.test(hostPart)) host = Number.parseInt(hostPart, 10);
  }
  return {
    port,
    ...(host !== undefined && host >= 1 && host <= 65535 && host !== port
      ? { hostPort: host }
      : {}),
    ...(protocol === "udp" ? { protocol } : {}),
  };
}

/** One `volumes:` entry. Bind sources are resolved against the Compose file's directory. */
function volumeOf(entry: unknown, composeDir: string): VolumeMount | undefined {
  let source: unknown;
  let target: unknown;
  let readOnly = false;
  let type: unknown;
  if (typeof entry === "string") {
    const parts = entry.split(":");
    if (parts.length < 2 || parts.length > 3) return undefined;
    [source, target] = parts;
    readOnly = parts[2] === "ro";
    if (parts[2] !== undefined && parts[2] !== "ro" && parts[2] !== "rw") return undefined;
  } else if (isObj(entry)) {
    ({ source, target, type } = entry);
    readOnly = entry.read_only === true;
    if (type !== undefined && type !== "volume" && type !== "bind") return undefined;
  } else {
    return undefined;
  }
  if (typeof source !== "string" || typeof target !== "string" || !CONTAINER_PATH.test(target))
    return undefined;
  const bind = type === "bind" || source.startsWith(".") || source.startsWith("/");
  if (!bind) {
    return VOLUME_NAME.test(source)
      ? { source, target, ...(readOnly ? { readOnly } : {}), bind }
      : undefined;
  }
  if (isAbsolute(source) || !HOST_PATH.test(source)) return undefined;
  const resolved = normalize(join(composeDir, source));
  if (resolved === ".." || resolved.startsWith("../")) return undefined;
  return { source: resolved, target, ...(readOnly ? { readOnly } : {}), bind };
}

function envNames(environment: unknown): string[] {
  if (Array.isArray(environment)) {
    return environment
      .filter((e) => typeof e === "string")
      .map((e) => (e as string).split("=")[0] as string);
  }
  return isObj(environment) ? Object.keys(environment) : [];
}

/** Literal environment values; interpolated ones (`${VAR}`) and empty entries are left for the user. */
function envValues(environment: unknown): Record<string, string> {
  const pairs: [string, unknown][] = Array.isArray(environment)
    ? environment
        .filter((e): e is string => typeof e === "string" && e.includes("="))
        .map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)])
    : isObj(environment)
      ? Object.entries(environment)
      : [];
  const out: Record<string, string> = {};
  for (const [key, raw] of pairs) {
    if (raw === null || raw === undefined || typeof raw === "object") continue;
    const value = String(raw);
    if (value.includes("${") || value.includes("\n")) continue;
    out[key] = value;
  }
  return out;
}

/** A value that is nothing but Compose interpolation, such as `${URL}` or `${PORT:-80}`. Holds no secret itself. */
const ONLY_REFERENCES = /^(\$\{[A-Za-z_][A-Za-z0-9_]*(?::?[-?+][^}\n]*)?\})+$/;

/** Values that are only `${VAR}` references, which service.json `env` can keep as they are (Flisk 1.4.24). */
function envReferences(environment: unknown): Record<string, string> {
  const pairs: [string, unknown][] = Array.isArray(environment)
    ? environment
        .filter((e): e is string => typeof e === "string" && e.includes("="))
        .map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)])
    : isObj(environment)
      ? Object.entries(environment)
      : [];
  const out: Record<string, string> = {};
  for (const [key, raw] of pairs) {
    if (typeof raw === "string" && ONLY_REFERENCES.test(raw)) out[key] = raw;
  }
  return out;
}

function commandOf(command: unknown): string | undefined {
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((c) => typeof c === "string"))
    return command.join(" ");
  return undefined;
}

function healthPathOf(healthcheck: unknown): string | undefined {
  if (!isObj(healthcheck) || !Array.isArray(healthcheck.test)) return undefined;
  const test = healthcheck.test
    .filter((part): part is string => typeof part === "string")
    .join(" ");
  const match = test.match(
    /(?:https?:\/\/[^\s"'/]+|(?:^|(?<=[\s"']))(?:[a-z0-9.-]+:\d+|localhost|127\.0\.0\.1))(\/[^\s"']*)/i,
  );
  if (!match) return undefined;
  try {
    const raw = match[0];
    return new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`).pathname || "/";
  } catch {
    return undefined;
  }
}

registerDetector({
  id: "compose",
  claim: (relPath) => relPath === "docker-compose.yml",
  parse(absPath, relPath) {
    const composeDir = dirname(relPath) === "." ? "" : dirname(relPath);
    const base = { file: relPath, detector: "compose" };
    const skips: Skip[] = [];
    const candidates: Candidate[] = [];

    const doc = parseDocument(readFileSync(absPath, "utf8"), { merge: true });
    if (doc.errors.length > 0) {
      return {
        candidates,
        skips: [{ ...base, reason: `invalid YAML: ${doc.errors[0]?.message}` }],
      };
    }
    let usesAnchors = false;
    visit(doc, {
      Alias() {
        usesAnchors = true;
      },
      Node(_key, node: Node) {
        if ((node as { anchor?: string }).anchor || isAlias(node)) usesAnchors = true;
      },
    });
    if (usesAnchors) {
      skips.push({
        ...base,
        reason: "uses YAML anchors/aliases; values were read after resolution",
      });
    }
    const root = doc.toJS() as unknown;
    const services = isObj(root) && isObj(root.services) ? root.services : null;
    if (!services || !isMap(doc.get("services", true))) {
      return { candidates, skips: [...skips, { ...base, reason: "no `services:` map" }] };
    }

    for (const [name, raw] of Object.entries(services)) {
      if (!isObj(raw)) {
        skips.push({ ...base, reason: `service "${name}" is not a map` });
        continue;
      }
      if (raw.extends !== undefined) {
        skips.push({
          ...base,
          reason: `service "${name}" uses \`extends\`; values are not resolved`,
        });
        continue;
      }
      if (raw.profiles !== undefined) {
        skips.push({
          ...base,
          reason: `service "${name}" has profiles ${JSON.stringify(raw.profiles)}; profiles are not enforced by Flisk`,
        });
        continue;
      }

      let dir = composeDir;
      let dockerfile: string | undefined;
      let standalone = true;
      if (raw.build !== undefined) {
        const build = isObj(raw.build) ? raw.build : { context: raw.build };
        const context = typeof build.context === "string" ? build.context : ".";
        const resolved = normalize(join(composeDir, context));
        if (
          isAbsolute(context) ||
          context.includes("://") ||
          resolved === ".." ||
          resolved.startsWith("../")
        ) {
          skips.push({
            ...base,
            reason: `service "${name}" build context "${context}" is outside the imported directory; not imported`,
          });
          continue;
        }
        dir = resolved === "." ? "" : resolved;
        standalone = false;
        dockerfile = typeof build.dockerfile === "string" ? build.dockerfile : "Dockerfile";
      }

      const ports = [
        ...new Set(
          (Array.isArray(raw.ports) ? raw.ports : [])
            .map(containerPort)
            .filter((p): p is number => p !== undefined),
        ),
      ];
      const unreadable = (Array.isArray(raw.ports) ? raw.ports : []).filter(
        (entry) => containerPort(entry) === undefined,
      );
      if (unreadable.length > 0) {
        skips.push({
          ...base,
          reason:
            ports.length === 0
              ? `service "${name}" ports not understood (${JSON.stringify(unreadable)}); it is imported as a private service with no route`
              : `service "${name}" has port entries that were not understood and ignored (${JSON.stringify(unreadable)}); only ${ports.join(", ")} was read`,
        });
      }
      const httpPorts = ports.filter((port) => port <= 5999 && !NON_HTTP_PORTS.has(port));
      const selectedPort =
        httpPorts.length === 1 ? httpPorts[0] : ports.length === 1 ? ports[0] : undefined;
      if (ports.length > 1 && selectedPort === undefined) {
        skips.push({
          ...base,
          reason: `service "${name}" lists several ports (${ports.join(", ")}); no single HTTP container port could be identified, so none is routed (all are published on 127.0.0.1 as extraPorts)`,
        });
      } else if (ports.length > 1) {
        skips.push({
          ...base,
          reason: `service "${name}" publishes extra container ports (${ports.filter((port) => port !== selectedPort).join(", ")}); Flisk routes only ${selectedPort} and publishes the others on 127.0.0.1 as extraPorts`,
        });
      }
      const dependsOn = Array.isArray(raw.depends_on)
        ? raw.depends_on.filter((d): d is string => typeof d === "string")
        : isObj(raw.depends_on)
          ? Object.keys(raw.depends_on)
          : [];
      const command = commandOf(raw.command);
      const envKeys = envNames(raw.environment);
      const env = envValues(raw.environment);
      const envRefs = envReferences(raw.environment);
      const foundHealthPath = healthPathOf(raw.healthcheck);
      const healthCheckPath =
        foundHealthPath && HEALTH_CHECK_PATH_PATTERN.test(foundHealthPath)
          ? foundHealthPath
          : undefined;
      if (foundHealthPath && !healthCheckPath) {
        skips.push({
          ...base,
          reason: `service "${name}" health path "${foundHealthPath}" has characters Flisk does not accept (only a-z, 0-9, / and -); not used`,
        });
      }
      const { container, dropped } = containerOf(raw);
      for (const key of dropped) {
        skips.push({
          ...base,
          reason: `service "${name}" ${key} ${JSON.stringify(raw[key])} has values Flisk does not accept; not used`,
        });
      }
      // Every published port Flisk does not route stays published, on 127.0.0.1 (service.json extraPorts).
      const extraPorts = (Array.isArray(raw.ports) ? raw.ports : [])
        .map(publishedPort)
        .filter((p): p is ExtraPort => p !== undefined && p.port !== selectedPort);
      let sidecarOf: string | undefined;
      if (raw.network_mode !== undefined) {
        const mode = typeof raw.network_mode === "string" ? raw.network_mode : "";
        if (mode.startsWith("service:") && mode.length > "service:".length) {
          sidecarOf = mode.slice("service:".length);
        } else {
          skips.push({
            ...base,
            reason: `service "${name}" network_mode "${mode}" is not translated; Flisk only shares another service's network (service:<name>)`,
          });
        }
      }
      const volumes: VolumeMount[] = [];
      for (const entry of Array.isArray(raw.volumes) ? raw.volumes : []) {
        const volume = volumeOf(entry, composeDir);
        if (volume) volumes.push(volume);
        else
          skips.push({
            ...base,
            reason: `service "${name}" volume ${JSON.stringify(entry)} is not translated (an anonymous volume, a path outside the imported directory, or Compose variables); not mounted`,
          });
      }
      const restart =
        typeof raw.restart === "string" && RESTART.has(raw.restart)
          ? (raw.restart as Candidate["restart"])
          : undefined;
      if (raw.restart !== undefined && !restart) {
        skips.push({
          ...base,
          reason: `service "${name}" restart ${JSON.stringify(raw.restart)} is not a policy Flisk accepts; not used`,
        });
      }
      const untranslated = Object.keys(raw).filter((key) => !TRANSLATED_KEYS.has(key));
      if (untranslated.length) {
        skips.push({
          ...base,
          reason: `service "${name}" keys not translated: ${untranslated.join(", ")}`,
        });
      }
      // Any single published port that is not a known database/broker port is treated as HTTP,
      // including 8000 and 8080; a service with no published port stays private, as in Compose.
      const exposeViaProxy = selectedPort !== undefined && !NON_HTTP_PORTS.has(selectedPort);

      candidates.push({
        kind: "service",
        name,
        dir,
        standalone,
        ...(typeof raw.image === "string" ? { image: raw.image } : {}),
        ...(dockerfile ? { dockerfile } : {}),
        ...(command ? { command } : {}),
        ...(selectedPort !== undefined ? { port: selectedPort } : {}),
        ...(healthCheckPath ? { healthCheckPath } : {}),
        exposeViaProxy,
        ...(envKeys.length ? { envKeys } : {}),
        ...(Object.keys(env).length ? { env } : {}),
        ...(Object.keys(envRefs).length ? { envRefs } : {}),
        ...(dependsOn.length ? { dependsOn } : {}),
        ...(container ? { container } : {}),
        ...(extraPorts.length ? { extraPorts } : {}),
        ...(sidecarOf ? { sidecarOf } : {}),
        ...(volumes.length ? { volumes } : {}),
        ...(restart ? { restart } : {}),
        confidence: "high",
        sources: [base],
      });
    }
    return { candidates, skips };
  },
});
