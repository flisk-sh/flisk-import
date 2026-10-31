import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Manifest constants of the Flisk service.json this tool writes. */
export const SERVICE_MANIFEST_SCHEMA_VERSION = 1;
export const SERVICE_MANIFEST_SCHEMA_URL = "https://flisk.sh/schema.service.json";
/**
 * Oldest Flisk core that starts an imported project: 1.3.104 added `buildContext`, 1.3.145
 * (flisk#1018) bootstraps a project that has `.flisk/project.json` but no Tiltfile yet, and the
 * release after 1.4.10 (flisk#2646) accepts a bring-your-own port outside 4000-5999 and two-letter
 * names, which this importer now writes. Stated, not checked: it does not read the installed version.
 */
export const MIN_CORE_VERSION = "1.4.11";
/**
 * The core change that runs a registered Tiltfile (`orchestration.source: "tiltfile"`) from `flisk up`. Stated, not
 * checked, like MIN_CORE_VERSION.
 */
export const TILTFILE_CORE = "flisk-sh/flisk#2849";
/** Flisk's bring-your-own port range. */
export const BYO_PORT_RANGE = { min: 4000, max: 5999, label: "4000-5999" } as const;

/**
 * Values Flisk copies into generated Compose and Traefik config must match these, or `flisk up` refuses
 * the manifest (flisk `cli/src/utils/service-manifest.ts`, engine `manifest/parser.star`).
 */
export const HEALTH_CHECK_PATH_PATTERN = /^\/[a-z0-9/-]*$/;
export const IMAGE_PATTERN = /^[A-Za-z0-9._/:@-]+$/;

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateName(
  label: "Resource name" | "Stack name",
  name: string,
): { valid: boolean; error?: string } {
  return KEBAB.test(name)
    ? { valid: true }
    : {
        valid: false,
        error: `${label} "${name}" must use lowercase letters, numbers, and hyphens only`,
      };
}

/** Nearest directory at or above `start` holding `.flisk/project.json`. */
export function findProjectRoot(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".flisk", "project.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The minimal `.flisk/project.json` an import writes when the repo is not a Flisk project yet: the given stacks in
 * Pre-Alpha, no optional infrastructure, and discovery of every `services/<stack>/<name>` folder. A copy of the minimum
 * Flisk accepts today, so it can drift from flisk.
 */
export function defaultProjectConfig(
  projectRoot: string,
  preAlpha: { description: string; enabledStacks: string[] },
): Record<string, unknown> {
  return {
    version: "1.0",
    project: { name: basename(projectRoot), version: "1.0.0" },
    phases: {
      pre_alpha: { name: "Pre-Alpha", ...preAlpha },
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
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const PHASES = ["pre_alpha", "alpha", "beta", "out_of_scope"] as const;
const OPTIONAL_INFRA = ["monitoring", "elk", "debezium", "golden_image", "verdaccio"] as const;

/**
 * The fields of an existing `.flisk/project.json` that Flisk core would refuse, missing or of the wrong type, as dotted
 * names such as `project.name`. A whole object that is absent is named once (`optional_infra`), not field by field.
 * Empty when `flisk up` can read the file. A copy of core's `normalizeProjectConfig` (flisk
 * `cli/src/generator/template-engine.ts`), so it can drift from flisk.
 */
export function missingProjectFields(config: Record<string, unknown>): string[] {
  const missing: string[] = [];
  if (typeof config.version !== "string") missing.push("version");

  if (!isObject(config.project)) missing.push("project");
  else
    for (const key of ["name", "version"])
      if (typeof config.project[key] !== "string") missing.push(`project.${key}`);

  // Core also reads the older `stacks` shape, with `services` in place of `enabledStacks`.
  const phaseGaps = (value: unknown, label: string, field: string): string[] => {
    if (!isObject(value)) return [label];
    return PHASES.filter((phase) => {
      const entry = value[phase];
      return !isObject(entry) || !Array.isArray(entry[field]);
    }).map((phase) => `${label}.${phase}.${field}`);
  };
  const phases = phaseGaps(config.phases, "phases", "enabledStacks");
  if (phases.length && phaseGaps(config.stacks, "stacks", "services").length)
    missing.push(...phases);

  if (!isObject(config.optional_infra)) missing.push("optional_infra");
  else {
    const infra = config.optional_infra;
    for (const key of OPTIONAL_INFRA)
      if (typeof infra[key] !== "boolean") missing.push(`optional_infra.${key}`);
  }

  if (!isObject(config.discovery)) missing.push("discovery");
  else if (!Array.isArray(config.discovery.paths)) missing.push("discovery.paths");

  if (
    config.capabilities !== undefined &&
    !(
      isObject(config.capabilities) &&
      Object.values(config.capabilities).every((flag) => typeof flag === "boolean")
    )
  )
    missing.push("capabilities");
  return missing;
}
