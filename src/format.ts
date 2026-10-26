import type { ImportPlan } from "./plan.js";
import type { WritePlan } from "./write.js";
import { manifestRelPath } from "./write.js";

const STATUS_TEXT = {
  create: "create",
  overwrite: "overwrite (--force)",
  exists: "exists, kept (use --force to overwrite)",
} as const;

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
  for (const service of plan.services) {
    const item = writes.items.find((i) => i.service === service);
    out.push(`  ${service.name}  (${service.kind}${service.dir ? `, ${service.dir}/` : ""})`);
    out.push(
      `    from:      ${service.sources.map((s) => `${s.file} [${s.detector}]`).join(", ")}`,
    );
    if (service.dockerfile)
      out.push(`    build:     ${service.dir || "."}/ with ${service.dockerfile}`);
    else if (service.image) out.push(`    image:     ${service.image}`);
    const manifest = item && item.status !== "exists" ? item.manifest : undefined;
    if (manifest) {
      out.push(
        `    port:      ${manifest.port} ${manifest.port === service.port ? "(from Compose)" : "(assigned)"}`,
      );
      out.push(
        manifest.exposeViaProxy === false
          ? `    proxy:     none, private (${service.port === undefined ? "no single published port" : `${service.port} is a database or broker port`})`
          : "    proxy:     routed through Traefik",
      );
      if (manifest.healthCheckPath)
        out.push(
          `    health:    ${manifest.healthCheckPath}${service.healthCheckPath ? "" : " (assumed)"}`,
        );
    }
    if (service.dependsOn.length) out.push(`    depends:   ${service.dependsOn.join(", ")}`);
    if (service.language)
      out.push(`    runtime:   ${service.language} (detected, not mapped to a native provider)`);
    if (service.envKeys.length)
      out.push(`    env:       ${service.envKeys.join(", ")} (names only)`);
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
