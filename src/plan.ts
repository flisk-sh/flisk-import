import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import "./detectors/index.js";
import { ImportError } from "./errors.js";
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

const COMPOSE_FILE = "docker-compose.yml";
/** Names `docker compose` also picks up, in its own order of preference. They are read only when docker-compose.yml is absent. */
const OTHER_COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml"];
/** Files `docker compose up` merges over the main file; none of them is applied. */
const OVERRIDE_FILES = [
  "compose.override.yaml",
  "compose.override.yml",
  "docker-compose.override.yaml",
  "docker-compose.override.yml",
];

/** Read the one supported input, the root Compose file. This function writes nothing. */
export function buildPlan(dir: string): ImportPlan {
  const root = resolve(dir);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${dir} is not a directory`);
  }
  const detectors = selectDetectors(["compose"]);
  const candidates: Candidate[] = [];
  const skips: Skip[] = [];
  const isFile = (name: string) =>
    statSync(resolve(root, name), { throwIfNoEntry: false })?.isFile() ?? false;

  const present = OTHER_COMPOSE_FILES.filter(isFile);
  const composePath = isFile(COMPOSE_FILE) ? COMPOSE_FILE : present[0];
  if (!composePath) {
    throw new ImportError(
      `No root docker-compose.yml found in ${root} (nor compose.yaml); flisk import reads only the root Compose file`,
      ["Run flisk import in the directory that holds docker-compose.yml (or compose.yaml)"],
    );
  }
  for (const name of present.filter((n) => n !== composePath)) {
    skips.push({
      file: name,
      detector: "compose",
      reason: `not read; \`docker compose\` prefers it over ${composePath}, so what it runs may differ from this plan`,
    });
  }
  for (const name of OVERRIDE_FILES.filter(isFile)) {
    skips.push({
      file: name,
      detector: "compose",
      reason: `not applied; \`docker compose up\` merges it over ${composePath}, flisk import does not`,
    });
  }
  for (const detector of detectors) {
    if (!detector.claim(composePath)) continue;
    try {
      const result = detector.parse(resolve(root, composePath), composePath);
      candidates.push(...result.candidates);
      skips.push(...result.skips);
    } catch (err) {
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
