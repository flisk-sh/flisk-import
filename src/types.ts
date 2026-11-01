export type CandidateKind = "service" | "job";
export type Confidence = "high" | "low";

export interface Source {
  /** Path relative to the import root, with `/` separators. */
  file: string;
  detector: string;
}

/**
 * What a detector learned about one process. Only fields the source file states are set;
 * nothing is defaulted. The writer is the only stage that knows the Flisk manifest layout.
 */
export interface Candidate {
  kind: CandidateKind;
  /** Undefined means the file describes its directory, not a named service (Dockerfile, package.json). */
  name?: string;
  /** Directory the candidate belongs to, relative to the import root ("" is the root). */
  dir: string;
  /** A named candidate that never absorbs anonymous ones (a Compose service with only `image:`). */
  standalone?: boolean;
  image?: string;
  /** Dockerfile path relative to `dir`. */
  dockerfile?: string;
  command?: string;
  /** Compose `command` as the argument vector the container runs (a string runs through `sh -c`). */
  containerCommand?: string[];
  /** Compose `entrypoint` as the argument vector the container starts with. */
  containerEntrypoint?: string[];
  /** Compose `profiles`: the service starts only when one of them is asked for. */
  profiles?: string[];
  /** Compose `env_file` paths, relative to the import root. */
  envFile?: string[];
  /** Compose `models` the service uses (Docker Model Runner): the top-level name and the model reference. */
  models?: ModelRef[];
  /** Compose `healthcheck` as a probe command that exits 0 when the service is ready. */
  healthCheck?: HealthCheckProbe | false;
  /** The port the service listens on inside its container, as stated by the source. */
  port?: number;
  /** HTTP path found in a Compose healthcheck, when it uses an explicit URL. */
  healthCheckPath?: string;
  /** Whether Flisk should expose this service through its Traefik router. */
  exposeViaProxy?: boolean;
  /** Set only when the source plainly names the runtime. */
  language?: "bun" | "node";
  /** Environment variable names. */
  envKeys?: string[];
  /**
   * Literal values the source states for those names. They go to the project .env (gitignored), never into
   * service.json; a value that uses Compose interpolation (`${VAR}`) is left out.
   */
  env?: Record<string, string>;
  /** Values that are only Compose interpolation (`${VAR}`, `${VAR:-default}`), kept as written for service.json `env`. */
  envRefs?: Record<string, string>;
  dependsOn?: string[];
  /** Compose depends_on conditions by raw dependency name, when Compose states one (flisk 1.4.28 dependsOn objects). */
  dependsOnConditions?: Record<string, DependsOnCondition>;
  /** Compose build.args, NAME to a string that may use Compose variables (flisk 1.4.28 buildArgs). */
  buildArgs?: Record<string, string>;
  /** Compose logging (flisk 1.4.28 logging). */
  logging?: { driver?: string; options?: Record<string, string> };
  /** Compose container options (cap_add, read_only, ...) as service.json `container` (Flisk 1.5, flisk#2907). */
  container?: ContainerOptions;
  /** Ports published next to the routed one, as service.json `extraPorts` (flisk#2909). */
  extraPorts?: ExtraPort[];
  /** Raw Compose name from `network_mode: service:<name>`, as service.json `sidecarOf` (flisk#2908). */
  sidecarOf?: string;
  /** Named volumes and bind mounts, as service.json `volumes` (flisk#1748). Bind sources are relative to the import root. */
  volumes?: VolumeMount[];
  /** A Compose restart policy; `on-failure:N` keeps its retry limit (N from 1 to 100). */
  restart?: "no" | "on-failure" | "unless-stopped" | "always" | `on-failure:${number}`;
  confidence: Confidence;
  sources: Source[];
}

export type DependsOnCondition =
  | "service_started"
  | "service_healthy"
  | "service_completed_successfully";

export interface ModelRef {
  name: string;
  model: string;
}

export interface HealthCheckProbe {
  command: string[];
  /** Seconds. */
  interval?: number;
  timeout?: number;
  retries?: number;
  /** Seconds before failed probes count (Compose start_period). */
  startPeriod?: number;
}

export interface ContainerOptions {
  capAdd?: string[];
  capDrop?: string[];
  init?: boolean;
  readOnly?: boolean;
  user?: string;
  securityOpt?: string[];
  shmSize?: string;
  /** Compose tmpfs, each /path or /path:options. */
  tmpfs?: string[];
  /** Compose deploy.resources.limits. */
  cpus?: number | string;
  memory?: string;
  /** Compose stop_grace_period, a duration such as 30s, 1m30s or 500ms. */
  stopGracePeriod?: string;
  /** Other DNS names for this service on its network: Compose `networks.<net>.aliases`, and a renamed service's Compose name. */
  networkAliases?: string[];
  /** Compose extra_hosts, each `name:address` (an IP or host-gateway). */
  extraHosts?: string[];
  /** Compose ulimits: a number, or a soft and a hard limit. */
  ulimits?: Record<string, number | { soft: number; hard: number }>;
}

export interface ExtraPort {
  port: number;
  hostPort?: number;
  protocol?: "tcp" | "udp";
  /** "0.0.0.0" when the Compose file names that address on purpose; loopback is the default. A bare mapping uses `publish`. */
  bind?: "0.0.0.0";
  /** The host side as Compose wrote it: a bare host port ("3000", every interface incl. IPv6), another address, or a `${VAR:-default}` (flisk#2947, flisk#2996). */
  publish?: string;
}

export interface VolumeMount {
  /** A volume name, or (when `bind`) a path relative to the import root. */
  source: string;
  target: string;
  readOnly?: boolean;
  bind: boolean;
  /** The Docker volume's own name as Compose created it (myapp_data), so Flisk keeps using the install's data. */
  name?: string;
  /** A bind path from the environment, `${NAME:-./path}`: `source` is the default path, this is NAME and the operator. */
  fromEnv?: { name: string; op: ":-" | "-" };
  /** SELinux relabel option of a bind mount (Compose :z / :Z). */
  selinux?: "z" | "Z";
}

export interface Skip {
  file: string;
  detector: string;
  reason: string;
  line?: number;
}

export interface ParseResult {
  candidates: Candidate[];
  skips: Skip[];
}

export interface Detector {
  id: string;
  /** Cheap: decides from the relative path alone. */
  claim(relPath: string): boolean;
  parse(absPath: string, relPath: string): ParseResult;
}

export interface ScanResult {
  /** Relative paths, `/` separators, sorted. */
  files: string[];
  notes: string[];
}
