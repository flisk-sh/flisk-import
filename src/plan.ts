import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import "./detectors/index.js";
import { ImportError } from "./errors.js";
import { isPathWithin } from "./flisk.js";
import { type MergedService, mergeCandidates } from "./merge.js";
import { selectDetectors } from "./registry.js";
import { scanTree } from "./scan.js";
import type { Candidate, Skip } from "./types.js";
import { findUnsupported } from "./unsupported.js";

export interface ImportPlan {
  root: string;
  services: MergedService[];
  skips: Skip[];
  /** Formats found but not imported (Helm, Kustomize), by name. */
  unsupported: string[];
  /** Valid Procfile processes skipped because no supported command, Dockerfile, or image exists. */
  skippedProcfileProcesses: number;
  notes: string[];
  files: string[];
}

/** Root Compose filenames in the order `docker compose` prefers them. */
const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"];
/** Files `docker compose up` merges over the main file; none of them is applied. */
const OVERRIDE_FILES = [
  "compose.override.yaml",
  "compose.override.yml",
  "docker-compose.override.yaml",
  "docker-compose.override.yml",
];

export interface BuildPlanOptions {
  /** Compose file selected with `--file`, resolved inside the import root. */
  file?: string;
}

/** Validate a `--file` path and return it relative to the import root. */
function explicitComposePath(root: string, file: string): string {
  const abs = resolve(root, file);
  if (!isPathWithin(root, abs)) {
    throw new ImportError(
      `--file ${file} escapes the project directory; it must stay inside ${root}`,
      ["Pass a Compose file inside the project directory"],
    );
  }
  const stat = statSync(abs, { throwIfNoEntry: false });
  if (!stat) {
    throw new ImportError(`--file ${file} does not exist in the project directory ${root}`, [
      "Pass an existing Compose file inside the project directory",
    ]);
  }
  if (stat.isDirectory()) {
    throw new ImportError(`--file ${file} is a directory, not a Compose file`, [
      "Pass the Compose file itself, such as compose.yaml or deploy/compose.prod.yml",
    ]);
  }
  if (!stat.isFile()) {
    throw new ImportError(`--file ${file} is not a regular file`, [
      "Pass a Compose file inside the project directory",
    ]);
  }
  return relative(root, abs).split("\\").join("/");
}

/** Read the one selected Compose input. This function writes nothing. */
export function buildPlan(dir: string, options: BuildPlanOptions = {}): ImportPlan {
  const root = resolve(dir);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${dir} is not a directory`);
  }
  const detectors = selectDetectors(["compose"]);
  const candidates: Candidate[] = [];
  const skips: Skip[] = [];
  const isFile = (name: string) =>
    statSync(resolve(root, name), { throwIfNoEntry: false })?.isFile() ?? false;

  const present = COMPOSE_FILES.filter(isFile);
  const composePath =
    options.file === undefined ? present[0] : explicitComposePath(root, options.file);
  if (!composePath) {
    throw new ImportError(
      `No root Compose file found in ${root} (looked for ${COMPOSE_FILES.join(", ")})`,
      [
        `Run flisk import in the directory that holds one of ${COMPOSE_FILES.join(", ")}, or pass --file <path>`,
      ],
    );
  }
  for (const name of present.filter((n) => n !== composePath)) {
    skips.push({
      file: name,
      detector: "compose",
      reason:
        options.file === undefined
          ? `not read; \`docker compose\` prefers ${composePath} over it`
          : `not read; --file selected ${composePath}`,
    });
  }
  for (const name of OVERRIDE_FILES.filter(isFile)) {
    skips.push({
      file: name,
      detector: "compose",
      reason:
        options.file === undefined
          ? `not applied; \`docker compose up\` merges it over ${composePath}, flisk import does not`
          : "not applied; flisk import reads only the selected Compose file",
    });
  }
  for (const detector of detectors) {
    if (options.file === undefined && !detector.claim(composePath)) continue;
    try {
      const result = detector.parse(resolve(root, composePath), composePath);
      candidates.push(...result.candidates);
      skips.push(...result.skips);
    } catch (err) {
      // The root file is the only input: a dedicated ImportError (such as invalid YAML) fails the
      // import instead of leaving a skip note under an otherwise normal plan.
      if (err instanceof ImportError) throw err;
      skips.push({
        file: composePath,
        detector: detector.id,
        reason: `could not be read: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const unsupported = findUnsupported(scanTree(root).files);
  const merged = mergeCandidates(candidates, basename(root));
  const services = merged.services;
  return {
    root,
    services,
    skips: [...skips, ...merged.skips, ...unsupported.skips],
    unsupported: unsupported.labels,
    skippedProcfileProcesses: 0,
    notes: [],
    files: [composePath],
  };
}

/** Ports already claimed by service.json files under `dir` (best effort). */
export function usedManifestPorts(dir: string): Map<string, number> {
  const ports = new Map<string, number>();
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive: true }).map(String);
  } catch {
    return ports;
  }
  for (const entry of entries) {
    if (!entry.endsWith("service.json") || entry.split(/[\\/]/).includes("node_modules")) continue;
    const abs = resolve(dir, entry);
    try {
      const port = JSON.parse(readFileSync(abs, "utf8")).port;
      if (typeof port === "number") ports.set(abs, port);
    } catch {
      // unreadable or not JSON: it claims no port
    }
  }
  return ports;
}
