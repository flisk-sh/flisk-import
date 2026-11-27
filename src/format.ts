import type { ImportPlan } from "./plan.js";
import type { VolumeMount } from "./types.js";
import type { WritePlan } from "./write.js";
import { manifestRelPath } from "./write.js";

const STATUS_TEXT = {
  create: "create",
  overwrite: "overwrite (--force)",
  exists: "exists, kept (use --force to overwrite)",
} as const;

type Dependency = string | { name: string; condition?: string };
type ExtraPort = {
  port: number;
  hostPort?: number;
  protocol?: string;
  bind?: string;
  publish?: string;
};
type WrittenVolume = {
  source: string;
  target: string;
  readOnly?: boolean;
  selinux?: string;
  name?: string;
};
type HealthCheck = {
  command?: unknown;
  interval?: number;
  timeout?: number;
  retries?: number;
  startPeriod?: number;
};

const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function dependencyText(dependency: Dependency): string {
  if (typeof dependency === "string") return dependency;
  return `${dependency.name}${dependency.condition ? ` (${dependency.condition})` : ""}`;
}

function extraPortText(port: ExtraPort): string {
  const host = port.publish ?? port.hostPort ?? port.port;
  return `${host}->${port.port}/${port.protocol ?? "tcp"}`;
}

function originalVolumeSource(volume: VolumeMount): string {
  if (volume.fromEnv) return `\${${volume.fromEnv.name}${volume.fromEnv.op}${volume.source}}`;
  return volume.source.startsWith(".") ? volume.source : `./${volume.source}`;
}

function volumeText(volume: WrittenVolume, original?: VolumeMount): string {
  const bind = volume.source.startsWith(".") || volume.source.startsWith("${");
  const details = [bind ? "bind" : "named"];
  if (volume.readOnly) details.push("read-only");
  if (volume.selinux) details.push(`selinux ${volume.selinux}`);
  if (volume.name) details.push(`docker name ${volume.name}`);
  const source = bind && original ? originalVolumeSource(original) : volume.source;
  if (bind && original && source !== volume.source) details.push(`written as ${volume.source}`);
  return `${source}:${volume.target} (${details.join(", ")})`;
}

function healthCheckText(healthCheck: HealthCheck): string {
  const timing = [
    ["interval", healthCheck.interval],
    ["timeout", healthCheck.timeout],
    ["retries", healthCheck.retries],
    ["start period", healthCheck.startPeriod],
  ]
    .filter((pair): pair is [string, number] => typeof pair[1] === "number")
    .map(([label, seconds]) =>
      label === "retries" ? `retries ${seconds}` : `${label} ${seconds}s`,
    );
  return `${JSON.stringify(healthCheck.command ?? [])}${timing.length ? ` (${timing.join(", ")})` : ""}`;
}

/** The printed plan: what was found, where it came from, what conflicts, what was not translated. */
export function formatPlan(plan: ImportPlan, writes: WritePlan): string {
  const out: string[] = [];
  const jobs = plan.services.filter((s) => s.kind === "job").length;
  out.push(
    `Found ${plan.services.length - jobs} service(s) and ${jobs} job(s) in ${plan.root}`,
    `Read only: ${plan.files.join(", ")}. Lines below name what was not translated.`,
    "",
  );
  if (writes.projectConfig) out.push(`  .flisk/project.json  [create Flisk project]`, "");
  if (writes.projectConfigUpdate)
    out.push(
      `  .flisk/project.json  [add composeProjectNames.${writes.stack}: "${writes.composeProjectName}", so an export keeps the Compose project name]`,
      "",
    );
  for (const service of plan.services) {
    const item = writes.items.find((i) => i.service === service);
    out.push(`  ${service.name}  (${service.kind}${service.dir ? `, ${service.dir}/` : ""})`);
    out.push(
      `    from:      ${service.sources.map((s) => `${s.file} [${s.detector}]`).join(", ")}`,
    );
    if (service.dockerfile)
      out.push(
        `    build:     ${service.dir || "."}/ with ${service.dockerfile}${service.buildTarget ? ` (target ${service.buildTarget}, not written; final stage built)` : ""}`,
      );
    else if (service.image) out.push(`    image:     ${service.image}`);
    const manifest = item && item.status !== "exists" ? item.manifest : undefined;
    if (manifest) {
      out.push(
        `    port:      ${manifest.port} ${manifest.port === service.port ? "(from Compose)" : "(assigned)"}`,
      );
      const extraPorts = list<ExtraPort>(manifest.extraPorts);
      if (extraPorts.length)
        out.push(`    extraPorts: ${extraPorts.map(extraPortText).join(", ")}`);
      out.push(
        manifest.exposeViaProxy === false
          ? `    proxy:     none, private (${service.port === undefined ? "no single published port" : `${service.port} is a database or broker port`})`
          : "    proxy:     routed through Traefik",
      );
      const volumes = list<WrittenVolume>(manifest.volumes);
      if (volumes.length)
        out.push(
          `    volumes:   ${volumes
            .map((volume) =>
              volumeText(
                volume,
                (service.volumes ?? []).find(
                  (original) => original.bind && original.target === volume.target,
                ),
              ),
            )
            .join(", ")}`,
        );
      if (manifest.healthCheckPath)
        out.push(
          `    health:    ${manifest.healthCheckPath}${service.healthCheckPath ? "" : " (assumed)"}`,
        );
      if (manifest.healthCheck === false) out.push("    healthcheck: false");
      else if (manifest.healthCheck)
        out.push(`    healthcheck: ${healthCheckText(manifest.healthCheck as HealthCheck)}`);
      const dependencies = list<Dependency>(manifest.dependsOn);
      if (dependencies.length)
        out.push(`    depends:   ${dependencies.map(dependencyText).join(", ")}`);
      const profiles = list<string>(manifest.profiles);
      if (profiles.length) out.push(`    profiles:  ${profiles.join(", ")}`);
    } else if (service.dependsOn.length) out.push(`    depends:   ${service.dependsOn.join(", ")}`);
    if (service.language)
      out.push(`    runtime:   ${service.language} (detected, not mapped to a native provider)`);
    if (service.envKeys.length) {
      const committed = manifest ? Object.keys(object(manifest.env)) : [];
      const required = manifest ? list<string>(object(manifest.secrets).required) : [];
      const split = [
        ...(committed.length ? [`committed params: ${committed.join(", ")}`] : []),
        ...(required.length ? [`required secrets: ${required.join(", ")}`] : []),
      ];
      out.push(
        `    env:       ${service.envKeys.join(", ")} (${split.length ? split.join("; ") : "names only"})`,
      );
    }
    for (const conflict of service.conflicts) {
      const values = conflict.values
        .map((v) => `${v.value} (${v.sources.map((s) => s.file).join(", ")})`)
        .join(" vs ");
      out.push(`    CONFLICT ${conflict.field}: ${values}; not used`);
    }
    if (item) {
      out.push(`    write:     ${manifestRelPath(plan, item)}  [${STATUS_TEXT[item.status]}]`);
      for (const note of item.notes) out.push(`    note:      ${note}`);
    }
    out.push("");
  }
  for (const r of writes.rejected) out.push(`  not written: ${r.name}: ${r.reason}`, "");
  if (plan.skips.length) {
    out.push("Skipped / not fully imported:");
    for (const skip of plan.skips) {
      out.push(
        `  ${skip.file}${skip.line ? `:${skip.line}` : ""} [${skip.detector}]: ${skip.reason}`,
      );
    }
    out.push("");
  }
  if (plan.notes.length) {
    out.push("Scan notes:");
    for (const note of plan.notes) out.push(`  ${note}`);
    out.push("");
  }
  return out.join("\n");
}
