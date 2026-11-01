import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize } from "node:path/posix";
import { isAlias, isMap, type Node, parseDocument, visit } from "yaml";
import { HEALTH_CHECK_PATH_PATTERN, NETWORK_ALIAS } from "../flisk.js";
import { registerDetector } from "../registry.js";
import type {
  Candidate,
  ContainerOptions,
  ExtraPort,
  HealthCheckProbe,
  ModelRef,
  Skip,
  VolumeMount,
} from "../types.js";

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
  "command",
  "entrypoint",
  "models",
  "profiles",
  "env_file",
  "tmpfs",
  "deploy",
  "stop_grace_period",
  "extra_hosts",
  "ulimits",
  // Only `aliases` is read from networks: Flisk gives every service its own stack network.
  "networks",
  "expose",
  // Flisk names every container itself; the plan says so.
  "container_name",
]);

const CAPABILITY = /^[A-Z_]+$/;
const USER = /^[A-Za-z0-9_.:-]+$/;
const SECURITY_OPT = /^[A-Za-z0-9_.:=/-]+$/;
const VOLUME_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const CONTAINER_PATH = /^\/[A-Za-z0-9_./-]*$/;
const HOST_PATH = /^[A-Za-z0-9_./-]+$/;
const RESTART = new Set(["no", "on-failure", "unless-stopped", "always"]);
/** `on-failure:N` with a retry limit from 1 to 100. */
const RESTART_LIMIT = /^on-failure:([1-9][0-9]?|100)$/;
/** A Compose duration such as 30s, 1m30s or 500ms. */
const DURATION = /^(?:[0-9]+(?:\.[0-9]+)?(?:h|ms|us|m|s))+$/;
const EXTRA_HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/;
/** An extra_hosts address: host-gateway, IPv4, or IPv6 (optionally in brackets). */
const EXTRA_HOST_ADDRESS =
  /^(?:host-gateway|[0-9]{1,3}(?:\.[0-9]{1,3}){3}|\[?[0-9A-Fa-f.]*:[0-9A-Fa-f.]*:[0-9A-Fa-f:.]*\]?)$/;
const ULIMIT_NAME = /^[a-z]+$/;

/** One extra_hosts entry as `name:address`; undefined when either side is not one Flisk accepts. */
function extraHostOf(name: unknown, address: unknown): string | undefined {
  if (typeof name !== "string" || typeof address !== "string") return undefined;
  return EXTRA_HOST_NAME.test(name) && EXTRA_HOST_ADDRESS.test(address)
    ? `${name}:${address}`
    : undefined;
}

/** Compose extra_hosts in list form (`name:address` or `name=address`) or map form. */
function extraHostsOf(value: unknown): { kept: string[]; bad: unknown[] } {
  const kept: string[] = [];
  const bad: unknown[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      const at = typeof entry === "string" ? entry.search(/[:=]/) : -1;
      const host =
        typeof entry === "string" && at > 0
          ? extraHostOf(entry.slice(0, at), entry.slice(at + 1))
          : undefined;
      if (host) kept.push(host);
      else bad.push(entry);
    }
  } else if (isObj(value)) {
    for (const [name, address] of Object.entries(value)) {
      const host = extraHostOf(name, address);
      if (host) kept.push(host);
      else bad.push({ [name]: address });
    }
  } else {
    bad.push(value);
  }
  return { kept: [...new Set(kept)], bad };
}

type Ulimits = NonNullable<ContainerOptions["ulimits"]>;

/** Compose ulimits: each a whole number, or { soft, hard } whole numbers with soft no greater than hard. */
function ulimitsOf(value: unknown): { kept: Ulimits; bad: string[] } {
  const kept: Ulimits = {};
  const bad: string[] = [];
  if (!isObj(value)) return { kept, bad: [JSON.stringify(value)] };
  for (const [name, limit] of Object.entries(value)) {
    if (!ULIMIT_NAME.test(name)) bad.push(name);
    else if (typeof limit === "number" && Number.isInteger(limit)) kept[name] = limit;
    else if (
      isObj(limit) &&
      Number.isInteger(limit.soft) &&
      Number.isInteger(limit.hard) &&
      Object.keys(limit).every((k) => k === "soft" || k === "hard") &&
      (limit.hard === -1 || (limit.soft as number) <= (limit.hard as number))
    )
      kept[name] = { soft: limit.soft as number, hard: limit.hard as number };
    else bad.push(name);
  }
  return { kept, bad };
}

/** Aliases from every network in a `networks` map; the list form names networks only. */
function networkAliasesOf(value: unknown): { kept: string[]; bad: unknown[] } {
  const kept: string[] = [];
  const bad: unknown[] = [];
  if (!isObj(value)) return { kept, bad };
  for (const network of Object.values(value)) {
    if (!isObj(network) || network.aliases === undefined) continue;
    const aliases = Array.isArray(network.aliases) ? network.aliases : [network.aliases];
    for (const alias of aliases) {
      if (typeof alias === "string" && NETWORK_ALIAS.test(alias)) kept.push(alias);
      else bad.push(alias);
    }
  }
  return { kept: [...new Set(kept)], bad };
}

/** stop_grace_period, network aliases, extra_hosts and ulimits, and a line for each value that is not carried over. */
function networkOptionsOf(raw: Obj): { options: ContainerOptions; dropped: string[] } {
  const options: ContainerOptions = {};
  const dropped: string[] = [];
  if (raw.stop_grace_period !== undefined) {
    if (typeof raw.stop_grace_period === "string" && DURATION.test(raw.stop_grace_period))
      options.stopGracePeriod = raw.stop_grace_period;
    else
      dropped.push(
        `stop_grace_period ${JSON.stringify(raw.stop_grace_period)} is not a duration such as 30s or 1m30s; not used`,
      );
  }
  const aliases = networkAliasesOf(raw.networks);
  if (aliases.kept.length) options.networkAliases = aliases.kept;
  if (aliases.bad.length)
    dropped.push(
      `network aliases ${JSON.stringify(aliases.bad)} are not DNS names (letters, digits, '-', '_' and '.'); not used`,
    );
  if (raw.extra_hosts !== undefined) {
    const hosts = extraHostsOf(raw.extra_hosts);
    if (hosts.kept.length) options.extraHosts = hosts.kept;
    if (hosts.bad.length)
      dropped.push(
        `extra_hosts ${JSON.stringify(hosts.bad)} are not name:address (an IP or host-gateway); not used`,
      );
  }
  if (raw.ulimits !== undefined) {
    const limits = ulimitsOf(raw.ulimits);
    if (Object.keys(limits.kept).length) options.ulimits = limits.kept;
    if (limits.bad.length)
      dropped.push(
        `ulimits ${limits.bad.join(", ")} are not a whole number or { soft, hard } with soft <= hard; not used`,
      );
  }
  return { options, dropped };
}

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
/**
 * A `publish` value Flisk accepts: digits, dots, colons and `${NAME:-default}` or `${NAME-default}` with a port or IPv4
 * address:port default.
 */
const PUBLISH = /^(?:[0-9.:]|\$\{[A-Za-z_][A-Za-z0-9_]*:?-[0-9.:]+\})+$/;

/** The host address and port of a published port. Compose publishes on every interface unless an address is given. */
function hostSideOf(port: number, hostIp: string | undefined, hostPort: string | undefined) {
  const hostNumber = hostPort && /^\d+$/.test(hostPort) ? Number.parseInt(hostPort, 10) : undefined;
  const keepHostPort =
    hostNumber !== undefined && hostNumber >= 1 && hostNumber <= 65535 && hostNumber !== port
      ? { hostPort: hostNumber }
      : {};
  if (hostPort?.includes("${")) {
    const publish = hostIp ? `${hostIp}:${hostPort}` : hostPort;
    return PUBLISH.test(publish) ? { publish } : undefined;
  }
  if (hostIp === undefined || hostIp === "" || hostIp === "0.0.0.0") {
    // A bare container port ("3000") gets a random host port from Compose; Flisk keeps it on 127.0.0.1.
    return hostPort === undefined ? {} : { ...keepHostPort, bind: "0.0.0.0" as const };
  }
  if (hostIp === "127.0.0.1") return keepHostPort;
  const publish = `${hostIp}:${hostNumber ?? port}`;
  return /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(publish) ? { publish } : undefined;
}

/** Whether a `ports:` entry names a host port ("8000:8000", "127.0.0.1:8000:8000", `published:`), not only a container port. */
function hasHostSide(entry: unknown): boolean {
  if (isObj(entry)) return entry.published !== undefined;
  return typeof entry === "string" && (entry.split("/")[0] ?? "").includes(":");
}

function publishedPort(entry: unknown): ExtraPort | undefined {
  const port = containerPort(entry);
  if (port === undefined) return undefined;
  let protocol: "tcp" | "udp" = "tcp";
  let hostSide: ReturnType<typeof hostSideOf>;
  if (isObj(entry)) {
    const published = entry.published === undefined ? undefined : String(entry.published);
    const hostIp = typeof entry.host_ip === "string" ? entry.host_ip : undefined;
    if (entry.protocol === "udp") protocol = "udp";
    hostSide = hostSideOf(port, hostIp, published);
  } else if (typeof entry === "string") {
    const [mapping, proto] = entry.split("/");
    if (proto === "udp") protocol = "udp";
    // [HOST_IP:][HOST_PORT:]CONTAINER_PORT, where the host side may hold ${VAR:-default}, which has colons of its own.
    const match = (mapping ?? "").match(/^(?:(.*):)?([^:]+)$/);
    const host = match?.[1];
    if (host === undefined) hostSide = hostSideOf(port, undefined, undefined);
    else if (host.includes("${")) hostSide = hostSideOf(port, undefined, host);
    else {
      const at = host.lastIndexOf(":");
      hostSide =
        at === -1
          ? hostSideOf(port, undefined, host)
          : hostSideOf(port, host.slice(0, at), host.slice(at + 1));
    }
  } else {
    hostSide = {};
  }
  return {
    port,
    ...(hostSide ?? {}),
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

/** Compose's project name: top-level `name`, else the directory name, lowercased with other characters dropped. */
export function projectNameOf(root: unknown, absPath: string): string | undefined {
  const raw =
    isObj(root) && typeof root.name === "string" && !root.name.includes("$")
      ? root.name
      : basename(dirname(absPath));
  const name = raw.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return /^[a-z0-9]/.test(name) ? name : undefined;
}

/**
 * The Docker name of a named volume, as `docker compose up` created it: its own `name:`, the key itself when it is
 * `external`, else `<project>_<key>`. Undefined when the name uses Compose variables.
 */
function dockerVolumeName(
  key: string,
  volumes: unknown,
  project: string | undefined,
): string | undefined {
  const def = isObj(volumes) ? volumes[key] : undefined;
  if (isObj(def) && typeof def.name === "string")
    return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(def.name) ? def.name : undefined;
  if (isObj(def) && (def.external === true || isObj(def.external))) return key;
  return project ? `${project}_${key}` : undefined;
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

/** The end of the `${...}` expression that starts at `start`, nested defaults included; undefined when it is not one. */
function expressionEnd(text: string, start: number): number | undefined {
  if (!text.startsWith("${", start)) return undefined;
  const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(start + 2));
  if (!name) return undefined;
  let i = start + 2 + name[0].length;
  if (text[i] === "}") return i + 1;
  const op = /^:?[-?+]/.exec(text.slice(i));
  if (!op) return undefined;
  i += op[0].length;
  while (i < text.length) {
    if (text.startsWith("${", i)) {
      const end = expressionEnd(text, i);
      if (end === undefined) return undefined;
      i = end;
    } else if (text[i] === "}") return i + 1;
    else if (text[i] === "\n" || text[i] === "$") return undefined;
    else i++;
  }
  return undefined;
}

/**
 * A value that is nothing but Compose interpolation: `${URL}`, `${PORT:-80}`, `${PORT-80}`, nested `${A:-${B:-file}}`.
 * It holds no secret itself (a default is what the project's Compose file already commits), so it stays in `env`.
 */
export function isComposeExpression(value: string): boolean {
  let i = 0;
  while (i < value.length) {
    const end = expressionEnd(value, i);
    if (end === undefined) return false;
    i = end;
  }
  return value.length > 0;
}

/**
 * A value that mixes Compose expressions with literal text (`${SERVER_NAME:-localhost, :443}, php:80`), every `${`
 * starting a valid expression. Undefined when it is not one; else the literal text with the expressions taken out.
 */
export function composeTemplateText(value: string): string | undefined {
  if (!value.includes("${") || value.includes("\n")) return undefined;
  let literal = "";
  let i = 0;
  while (i < value.length) {
    if (value.startsWith("${", i)) {
      const end = expressionEnd(value, i);
      if (end === undefined) return undefined;
      i = end;
    } else {
      if (value[i] === "$" && value[i + 1] !== "$") return undefined;
      literal += value[i];
      i++;
    }
  }
  return literal;
}

/** Values with `${VAR}` references (alone or in literal text), which service.json `env` can keep as they are (Flisk 1.4.24). */
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
    if (typeof raw === "string" && composeTemplateText(raw) !== undefined) out[key] = raw;
  }
  return out;
}

function commandOf(command: unknown): string | undefined {
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((c) => typeof c === "string"))
    return command.join(" ");
  return undefined;
}

/**
 * A Compose `command`/`entrypoint` string split into arguments the way Compose splits it (shell words: whitespace,
 * '...' kept as it is, "..." with \" \\ \$ \` escapes, a backslash escaping the next character). Compose runs no shell.
 * Undefined when the quotes or a trailing backslash do not balance.
 */
export function shellWords(text: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) return undefined;
      word += text.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (ch === '"') {
      inWord = true;
      let closed = false;
      for (i++; i < text.length; i++) {
        const c = text[i] as string;
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === "\\" && i + 1 < text.length && '"\\$`'.includes(text[i + 1] as string)) {
          word += text[i + 1];
          i++;
        } else word += c;
      }
      if (!closed) return undefined;
    } else if (ch === "\\") {
      if (i + 1 >= text.length) return undefined;
      word += text[i + 1];
      inWord = true;
      i++;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

/**
 * Compose `command`/`entrypoint` as the argument vector the container runs. A list is kept as it is; a string is split
 * into words as Compose splits it, with no shell, so an image ENTRYPOINT (minio) gets `server /export` as its arguments.
 * Only a string that cannot be split, or that reads `$VAR` at run time, runs through `sh -c`; `shell` says why.
 */
function containerCommandOf(command: unknown): { argv: string[]; shell?: string } | undefined {
  if (typeof command === "string" && command.trim()) {
    if (command.includes("$")) return { argv: ["sh", "-c", command], shell: "uses $ variables" };
    const words = shellWords(command);
    return words?.length
      ? { argv: words }
      : { argv: ["sh", "-c", command], shell: "has unbalanced quotes" };
  }
  if (Array.isArray(command) && command.length > 0 && command.every((c) => typeof c === "string"))
    return { argv: command as string[] };
  return undefined;
}

const DURATION_UNIT: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 0.001, us: 0.000001 };

/** Seconds from a Compose duration such as `30s`, `2m` or `1m30s`; undefined for anything it cannot read exactly. */
function secondsOf(value: unknown): number | undefined {
  if (typeof value === "number" && value > 0) return value;
  if (typeof value !== "string") return undefined;
  if (/^\d+$/.test(value)) return Number(value) > 0 ? Number(value) : undefined;
  if (!DURATION.test(value)) return undefined;
  let seconds = 0;
  for (const [, amount, unit] of value.matchAll(/([0-9]+(?:\.[0-9]+)?)(h|ms|us|m|s)/g))
    seconds += Number(amount) * (DURATION_UNIT[unit as string] as number);
  seconds = Math.round(seconds * 1000) / 1000;
  return seconds > 0 ? seconds : undefined;
}

/** Compose `healthcheck` as a probe command (exit 0 is ready). `NONE` and `disable` give no probe. */
function healthProbeOf(healthcheck: unknown): HealthCheckProbe | undefined {
  if (!isObj(healthcheck) || healthcheck.disable === true) return undefined;
  const test = healthcheck.test;
  let command: string[] | undefined;
  if (typeof test === "string") command = ["sh", "-c", test];
  else if (Array.isArray(test) && test.every((t) => typeof t === "string")) {
    const [kind, ...rest] = test as string[];
    if (kind === "CMD" && rest.length > 0) command = rest;
    else if (kind === "CMD-SHELL" && rest.length > 0) command = ["sh", "-c", rest.join(" ")];
  }
  if (!command) return undefined;
  const interval = secondsOf(healthcheck.interval);
  const timeout = secondsOf(healthcheck.timeout);
  const startPeriod = secondsOf(healthcheck.start_period);
  const retries =
    typeof healthcheck.retries === "number" &&
    Number.isInteger(healthcheck.retries) &&
    healthcheck.retries > 0
      ? healthcheck.retries
      : undefined;
  return {
    command,
    ...(interval ? { interval } : {}),
    ...(timeout ? { timeout } : {}),
    ...(retries ? { retries } : {}),
    ...(startPeriod ? { startPeriod } : {}),
  };
}

/** The models a service uses, joined to their top-level definitions. A model without a literal `model` is skipped. */
function modelsOf(uses: unknown, defined: unknown): ModelRef[] | undefined {
  const names = Array.isArray(uses) ? uses : isObj(uses) ? Object.keys(uses) : [];
  const out: ModelRef[] = [];
  for (const name of names) {
    const def = isObj(defined) && typeof name === "string" ? defined[name] : undefined;
    if (
      typeof name === "string" &&
      isObj(def) &&
      typeof def.model === "string" &&
      /^[A-Za-z0-9_.-]+$/.test(name)
    )
      out.push({ name, model: def.model });
  }
  return out.length ? out : undefined;
}

const PROFILE = /^[a-z0-9][a-z0-9-]*$/;
const TMPFS = /^\/[A-Za-z0-9_./-]*(:[a-z0-9=,_-]+)?$/;

function profilesOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.every((p) => typeof p === "string" && PROFILE.test(p))
    ? [...new Set(value as string[])]
    : undefined;
}

/** Compose env_file entries (a string, strings, or { path, required }) as paths from the import root; undefined when one leaves it. */
function envFilesOf(value: unknown, composeDir: string): string[] | undefined {
  const entries = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const entry of entries) {
    const path = typeof entry === "string" ? entry : isObj(entry) ? entry.path : undefined;
    if (typeof path !== "string" || isAbsolute(path) || path.includes("$")) return undefined;
    const resolved = normalize(join(composeDir, path));
    if (resolved === ".." || resolved.startsWith("../") || !/^[A-Za-z0-9_./-]+$/.test(resolved))
      return undefined;
    out.push(resolved);
  }
  return out.length ? out : undefined;
}

/** tmpfs and deploy.resources.limits, and the parts that could not be carried over. */
function runtimeLimitsOf(raw: Obj): {
  tmpfs?: string[];
  cpus?: number | string;
  memory?: string;
  dropped: string[];
} {
  const dropped: string[] = [];
  const out: { tmpfs?: string[]; cpus?: number | string; memory?: string } = {};
  if (raw.tmpfs !== undefined) {
    const list =
      typeof raw.tmpfs === "string" ? [raw.tmpfs] : Array.isArray(raw.tmpfs) ? raw.tmpfs : [];
    const kept = list.filter((t): t is string => typeof t === "string" && TMPFS.test(t));
    if (kept.length !== list.length || list.length === 0) dropped.push("tmpfs");
    if (kept.length) out.tmpfs = kept;
  }
  if (raw.deploy !== undefined) {
    const deploy = isObj(raw.deploy) ? raw.deploy : {};
    const resources = isObj(deploy.resources) ? deploy.resources : {};
    const limits = isObj(resources.limits) ? resources.limits : {};
    const cpus = typeof limits.cpus === "number" ? String(limits.cpus) : limits.cpus;
    if (typeof cpus === "string" && /^[0-9]+(\.[0-9]{1,2})?$/.test(cpus) && Number(cpus) > 0)
      out.cpus = Number.isInteger(Number(cpus)) && Number(cpus) >= 1 ? Number(cpus) : cpus;
    else if (limits.cpus !== undefined) dropped.push("deploy.resources.limits.cpus");
    if (typeof limits.memory === "string" && /^[0-9]+([bBkKmMgG][bB]?)?$/.test(limits.memory))
      out.memory = limits.memory;
    else if (limits.memory !== undefined) dropped.push("deploy.resources.limits.memory");
    const other = [
      ...Object.keys(deploy)
        .filter((k) => k !== "resources")
        .map((k) => `deploy.${k}`),
      ...Object.keys(resources)
        .filter((k) => k !== "limits")
        .map((k) => `deploy.resources.${k}`),
    ];
    dropped.push(...other);
  }
  return { ...out, dropped };
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
  claim: (relPath) => /^(docker-)?compose\.ya?ml$/.test(relPath),
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

    const project = projectNameOf(root, absPath);
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
      const profiles = profilesOf(raw.profiles);
      if (raw.profiles !== undefined && !profiles) {
        skips.push({
          ...base,
          reason: `service "${name}" has profiles ${JSON.stringify(raw.profiles)} that Flisk cannot name (lowercase letters, digits and '-'); not imported`,
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
          reason: `service "${name}" lists several ports (${ports.join(", ")}); no single HTTP container port could be identified, so none is routed (all stay published, as extraPorts)`,
        });
      } else if (ports.length > 1) {
        skips.push({
          ...base,
          reason: `service "${name}" publishes extra container ports (${ports.filter((port) => port !== selectedPort).join(", ")}); Flisk routes only ${selectedPort} and keeps the others published as extraPorts`,
        });
      }
      const dependsOn = Array.isArray(raw.depends_on)
        ? raw.depends_on.filter((d): d is string => typeof d === "string")
        : isObj(raw.depends_on)
          ? Object.keys(raw.depends_on)
          : [];
      const command = commandOf(raw.command);
      const models = modelsOf(raw.models, isObj(root) ? root.models : undefined);
      const commandArgs = containerCommandOf(raw.command);
      const entrypointArgs = containerCommandOf(raw.entrypoint);
      const containerCommand = commandArgs?.argv;
      const containerEntrypoint = entrypointArgs?.argv;
      for (const [key, args] of [
        ["command", commandArgs],
        ["entrypoint", entrypointArgs],
      ] as const) {
        if (args?.shell)
          skips.push({
            ...base,
            reason: `service "${name}" ${key} ${JSON.stringify(raw[key])} ${args.shell}; it runs through sh -c, which Compose would not do`,
          });
      }
      // `disable: true` or `test: ["NONE"]` turns off the image's own HEALTHCHECK too, so it is kept as healthCheck: false.
      const healthOff =
        isObj(raw.healthcheck) &&
        (raw.healthcheck.disable === true ||
          (Array.isArray(raw.healthcheck.test) && raw.healthcheck.test[0] === "NONE"));
      const healthProbe = healthOff ? false : healthProbeOf(raw.healthcheck);
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
      const { container: options, dropped } = containerOf(raw);
      const limits = runtimeLimitsOf(raw);
      const { dropped: limitsDropped, ...limitValues } = limits;
      const network = networkOptionsOf(raw);
      const merged = { ...(options ?? {}), ...limitValues, ...network.options };
      const container = Object.keys(merged).length ? merged : undefined;
      for (const reason of network.dropped) {
        skips.push({ ...base, reason: `service "${name}" ${reason}` });
      }
      if (raw.container_name !== undefined) {
        skips.push({
          ...base,
          reason: `service "${name}" container_name ${JSON.stringify(raw.container_name)} is dropped: Flisk names containers itself; other services reach it by its service name`,
        });
      }
      for (const key of limitsDropped) {
        skips.push({ ...base, reason: `service "${name}" ${key} is not carried over; not used` });
      }
      const envFile = envFilesOf(raw.env_file, composeDir);
      if (raw.env_file !== undefined && !envFile) {
        skips.push({
          ...base,
          reason: `service "${name}" env_file ${JSON.stringify(raw.env_file)} is outside the imported directory or uses Compose variables; not used`,
        });
      }
      for (const key of dropped) {
        skips.push({
          ...base,
          reason: `service "${name}" ${key} ${JSON.stringify(raw[key])} has values Flisk does not accept; not used`,
        });
      }
      // Every published port stays published on the same host address (service.json extraPorts). The routed port too,
      // when Compose gives it a host side ("${APP_PORT:-8000}:8000"), so the app is still reachable without Traefik
      // (and in an exported docker-compose.yml); a bare routed "8000" is reached through Traefik only.
      const proxied = selectedPort !== undefined && !NON_HTTP_PORTS.has(selectedPort);
      const extraPorts = (Array.isArray(raw.ports) ? raw.ports : [])
        .filter((entry) => containerPort(entry) !== selectedPort || !proxied || hasHostSide(entry))
        .map(publishedPort)
        .filter((p): p is ExtraPort => p !== undefined);
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
        const dockerName =
          volume && !volume.bind
            ? dockerVolumeName(volume.source, isObj(root) ? root.volumes : undefined, project)
            : undefined;
        if (volume) volumes.push(dockerName ? { ...volume, name: dockerName } : volume);
        else
          skips.push({
            ...base,
            reason: `service "${name}" volume ${JSON.stringify(entry)} is not translated (an anonymous volume, a path outside the imported directory, or Compose variables); not mounted`,
          });
      }
      // `on-failure:5` caps the retries at 5; service.json keeps the cap (1 to 100).
      const restart =
        typeof raw.restart === "string" &&
        (RESTART.has(raw.restart) || RESTART_LIMIT.test(raw.restart))
          ? (raw.restart as Candidate["restart"])
          : undefined;
      if (raw.restart !== undefined && !restart) {
        skips.push({
          ...base,
          reason: `service "${name}" restart ${JSON.stringify(raw.restart)} is not a policy Flisk accepts (no, always, unless-stopped, on-failure, on-failure:1 to 100); not used`,
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
        ...(containerCommand ? { containerCommand } : {}),
        ...(containerEntrypoint ? { containerEntrypoint } : {}),
        ...(models ? { models } : {}),
        ...(profiles ? { profiles } : {}),
        ...(envFile ? { envFile } : {}),
        ...(healthProbe !== undefined ? { healthCheck: healthProbe } : {}),
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
        // Compose restarts nothing unless asked; Flisk defaults to unless-stopped, so "no" is written.
        ...(restart ? { restart } : raw.restart === undefined ? { restart: "no" as const } : {}),
        confidence: "high",
        sources: [base],
      });
    }
    return { candidates, skips };
  },
});
