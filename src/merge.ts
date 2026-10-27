import { basename } from "node:path/posix";
import { precedence } from "./registry.js";
import type { Candidate, CandidateKind, Confidence, Skip, Source } from "./types.js";

export interface Conflict {
  field: "image" | "dockerfile" | "command" | "port" | "language" | "healthCheckPath";
  values: { value: string; sources: Source[] }[];
}

export interface MergedService {
  name: string;
  originalName?: string;
  dir: string;
  kind: CandidateKind;
  image?: string;
  dockerfile?: string;
  command?: string;
  /** Procfile commands retained for the importer's buildability check. */
  procfileCommands: string[];
  port?: number;
  healthCheckPath?: string;
  exposeViaProxy?: boolean;
  language?: "bun" | "node";
  envKeys: string[];
  /** Literal values for envKeys, from the highest-precedence source that states one. */
  env: Record<string, string>;
  dependsOn: string[];
  conflicts: Conflict[];
  sources: Source[];
  confidence: Confidence;
}

export interface MergeResult {
  services: MergedService[];
  skips: Skip[];
}

function slug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function toResourceName(raw: string): string {
  let name = slug(raw) || "svc";
  // Resource names must start with a letter and be at least 2 characters (service schema), so a
  // Compose name such as `db` is kept and stays the container's hostname.
  if (!/^[a-z]/.test(name)) name = `svc-${name}`;
  if (name.length < 2) name = `${name}-svc`;
  return name;
}

/**
 * Maps every raw name in one project to a distinct resource name. Names that are already valid
 * claim their spelling first; the rest get a numeric suffix when they would collide (for example
 * `db` and `db-svc` both normalise to `db-svc`).
 */
export function assignResourceNames(rawNames: string[]): Map<string, string> {
  const unique = [...new Set(rawNames)].sort();
  const claimed = new Set<string>();
  const out = new Map<string, string>();
  const claim = (raw: string) => {
    const base = toResourceName(raw);
    let final = base;
    for (let n = 2; claimed.has(final); n++) final = `${base}-${n}`;
    claimed.add(final);
    out.set(raw, final);
  };
  const isValid = (raw: string) => toResourceName(raw) === raw;
  unique.filter(isValid).forEach(claim);
  unique.filter((raw) => !isValid(raw)).forEach(claim);
  return out;
}

const SCALAR_FIELDS = [
  "image",
  "dockerfile",
  "command",
  "port",
  "language",
  "healthCheckPath",
] as const;

function rank(candidate: Candidate): number {
  return Math.min(...candidate.sources.map((s) => precedence(s.detector)));
}

function mergeGroup(
  name: string,
  dir: string,
  members: Candidate[],
  resolve: (raw: string) => string,
): MergedService {
  const ordered = [...members].sort((a, b) => rank(a) - rank(b));
  const originalName = ordered.find((c) => c.name !== undefined && c.name !== name)?.name;
  const merged: MergedService = {
    name,
    ...(originalName ? { originalName } : {}),
    dir,
    kind: (ordered[0] as Candidate).kind,
    envKeys: [...new Set(ordered.flatMap((c) => c.envKeys ?? []))].sort(),
    env: Object.assign({}, ...[...ordered].reverse().map((c) => c.env ?? {})),
    dependsOn: [...new Set(ordered.flatMap((c) => (c.dependsOn ?? []).map(resolve)))].sort(),
    exposeViaProxy: ordered.find((c) => c.exposeViaProxy !== undefined)?.exposeViaProxy,
    procfileCommands: ordered.flatMap((c) =>
      c.sources.some((source) => source.detector === "procfile") && c.command ? [c.command] : [],
    ),
    conflicts: [],
    sources: [],
    confidence: ordered.every((c) => c.confidence === "high") ? "high" : "low",
  };
  for (const field of SCALAR_FIELDS) {
    const values = new Map<string, Source[]>();
    for (const c of ordered) {
      const v = c[field];
      if (v === undefined) continue;
      values.set(String(v), [...(values.get(String(v)) ?? []), ...c.sources]);
    }
    if (values.size === 1) {
      const holder = ordered.find((c) => c[field] !== undefined) as Candidate;
      (merged as unknown as Record<string, unknown>)[field] = holder[field];
    } else if (values.size > 1) {
      merged.conflicts.push({
        field,
        values: [...values].map(([value, sources]) => ({ value, sources })),
      });
    }
  }
  for (const c of ordered) {
    for (const s of c.sources) {
      if (!merged.sources.some((m) => m.file === s.file && m.detector === s.detector)) {
        merged.sources.push(s);
      }
    }
  }
  return merged;
}

/**
 * Groups candidates by directory and name. An anonymous candidate (Dockerfile, package.json)
 * joins the one named service in its directory, or becomes a service named after the directory.
 * It is never guessed onto one of several. A field two sources disagree on is a conflict and is omitted.
 */
export function mergeCandidates(candidates: Candidate[], rootName: string): MergeResult {
  const skips: Skip[] = [];
  const table = assignResourceNames([
    ...candidates.flatMap((c) => (c.name === undefined ? [] : [c.name])),
    ...candidates.flatMap((c) => c.dependsOn ?? []),
    ...candidates.flatMap((c) => (c.name === undefined ? [basename(c.dir) || rootName] : [])),
  ]);
  const resolve = (raw: string) => table.get(raw) ?? toResourceName(raw);
  const groups = new Map<string, { name: string; dir: string; members: Candidate[] }>();
  const keyOf = (dir: string, name: string) => `${dir}\0${name}`;

  for (const c of candidates) {
    if (c.name === undefined) continue;
    const name = resolve(c.name);
    const first = c.sources[0] as Source;
    if (!name) {
      skips.push({ ...first, reason: `"${c.name}" is not usable as a service name` });
      continue;
    }
    const key = keyOf(c.dir, name);
    const group = groups.get(key) ?? { name, dir: c.dir, members: [] };
    group.members.push(c);
    groups.set(key, group);
  }

  const anonymous = candidates.filter((c) => c.name === undefined);
  for (const c of anonymous) {
    const targets = [...groups.values()].filter(
      (g) => g.dir === c.dir && !g.members.every((m) => m.standalone),
    );
    if (targets.length === 1) {
      (targets[0] as { members: Candidate[] }).members.push(c);
    } else if (targets.length === 0) {
      const name = resolve(basename(c.dir) || rootName);
      if (!name) {
        skips.push({
          ...(c.sources[0] as Source),
          reason: "no usable service name for this directory",
        });
        continue;
      }
      const key = keyOf(c.dir, name);
      const group = groups.get(key) ?? { name, dir: c.dir, members: [] };
      group.members.push(c);
      groups.set(key, group);
    } else {
      const names = targets.map((g) => g.name).join(", ");
      skips.push({
        ...(c.sources[0] as Source),
        reason: `directory has several services (${names}); not guessed which one this file describes`,
      });
    }
  }

  const services = [...groups.values()]
    .map((g) => mergeGroup(g.name, g.dir, g.members, resolve))
    .sort((a, b) => (a.dir === b.dir ? (a.name < b.name ? -1 : 1) : a.dir < b.dir ? -1 : 1));
  return { services, skips };
}
