import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Manifest constants of the Flisk service.json this tool writes. */
export const SERVICE_MANIFEST_SCHEMA_VERSION = 1;
export const SERVICE_MANIFEST_SCHEMA_URL = "https://flisk.sh/schema.service.json";
/**
 * Oldest Flisk core that starts an imported project: 1.3.104 added `buildContext`, and 1.3.145
 * (flisk#1018) bootstraps a project that has `.tdk/project.json` but no Tiltfile yet.
 * Stated, not checked: the importer does not read the installed core version.
 */
export const MIN_CORE_VERSION = "1.3.145";
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

/** Nearest directory at or above `start` holding `.tdk/project.json`. */
export function findProjectRoot(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".tdk", "project.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
