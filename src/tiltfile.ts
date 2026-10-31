import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { ImportError } from "./errors.js";
import { defaultProjectConfig, findProjectRoot } from "./flisk.js";

/** What `flisk-import tiltfile` writes into `.flisk/project.json`. */
export interface TiltfileOrchestration {
  source: "tiltfile";
  /** The Tiltfile, relative to the project root, with forward slashes. */
  path: string;
}

export interface TiltfilePlan {
  /** Absolute path of the Tiltfile. It is read for existence only and never written. */
  tiltfile: string;
  /** Nearest directory holding `.flisk/project.json`, else the working directory. */
  projectRoot: string;
  projectJson: string;
  orchestration: TiltfileOrchestration;
  /** `create` when there is no `.flisk/project.json` yet; `update` keeps every other key. */
  action: "create" | "update";
  /** The `orchestration` value `--force` replaces, if any. */
  replaced?: unknown;
  /** The whole `.flisk/project.json` this import writes. */
  content: string;
}

const RERUN = "flisk import tiltfile <path>";

/** Describes an `orchestration` value for a message, for example `tiltfile: Tiltfile`. */
export function describeOrchestration(value: unknown): string {
  if (value && typeof value === "object" && "source" in value) {
    const { source, path } = value as { source?: unknown; path?: unknown };
    return `${String(source)}: ${typeof path === "string" && path ? path : "default"}`;
  }
  return JSON.stringify(value);
}

/**
 * Plans registering an existing Tiltfile as the project's orchestration source, so `flisk up` runs it unchanged.
 * `pathArg` is a file or a directory holding `Tiltfile`, resolved from `cwd`. Nothing is written here.
 */
export function planTiltfileImport(
  pathArg = "Tiltfile",
  options: { cwd?: string; force?: boolean } = {},
): TiltfilePlan {
  const cwd = resolve(options.cwd ?? process.cwd());
  // flisk up puts this path in a generated Tiltfile as a Starlark string, so refuse it before touching the disk.
  const hasUnsafeChar = (value: string) =>
    [...value].some((char) => char === '"' || char === "'" || char.charCodeAt(0) < 0x20);
  if (hasUnsafeChar(pathArg)) {
    throw new ImportError(
      `Tiltfile path ${JSON.stringify(pathArg)} has a quote or control character`,
      ["Rename the file or folder, then run: flisk import tiltfile <path>"],
    );
  }

  let tiltfile = resolve(cwd, pathArg);
  if (statSync(tiltfile, { throwIfNoEntry: false })?.isDirectory())
    tiltfile = join(tiltfile, "Tiltfile");

  const projectRoot = findProjectRoot(cwd) ?? cwd;
  const path = relative(projectRoot, tiltfile).split("\\").join("/");
  if (hasUnsafeChar(path)) {
    throw new ImportError(
      `Tiltfile path ${JSON.stringify(path)} has a quote or control character`,
      ["Rename the file or folder, then run: flisk import tiltfile <path>"],
    );
  }
  if (path === ".flisk" || path.startsWith(".flisk/")) {
    throw new ImportError(
      `${path} is inside .flisk/, where Flisk writes its generated files; import your own Tiltfile instead`,
      [`Point it at the Tiltfile you maintain: ${RERUN}`],
    );
  }
  if (!statSync(tiltfile, { throwIfNoEntry: false })?.isFile()) {
    throw new ImportError(`No Tiltfile found at ${pathArg}`, [
      `Pass the path of an existing Tiltfile, or a folder that holds one: ${RERUN}`,
    ]);
  }

  const projectJson = join(projectRoot, ".flisk", "project.json");
  const orchestration: TiltfileOrchestration = { source: "tiltfile", path };
  if (!existsSync(projectJson)) {
    const config = {
      ...defaultProjectConfig(projectRoot, {
        description: "Flisk proxy; flisk up runs the project's own Tiltfile",
        enabledStacks: ["proxy"],
      }),
      orchestration,
    };
    return {
      tiltfile,
      projectRoot,
      projectJson,
      orchestration,
      action: "create",
      content: `${JSON.stringify(config, null, 2)}\n`,
    };
  }

  let existing: unknown;
  try {
    existing = JSON.parse(readFileSync(projectJson, "utf8"));
  } catch (err) {
    throw new ImportError(
      `Cannot read ${projectJson}: ${err instanceof Error ? err.message : String(err)}`,
      ["Fix the JSON in .flisk/project.json, then run the import again"],
    );
  }
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    throw new ImportError(`${projectJson} is not a JSON object`, [
      "Fix .flisk/project.json, then run the import again",
    ]);
  }
  const config = existing as Record<string, unknown>;
  const replaced = config.orchestration;
  if (replaced !== undefined && !options.force) {
    throw new ImportError(
      `.flisk/project.json already sets orchestration (${describeOrchestration(replaced)})`,
      ["Pass --force to replace it; every other key is kept"],
    );
  }
  // Spreading keeps every key, and keeps `orchestration` where it was when --force replaces it.
  const next = { ...config, orchestration };
  return {
    tiltfile,
    projectRoot,
    projectJson,
    orchestration,
    action: "update",
    ...(replaced !== undefined ? { replaced } : {}),
    content: `${JSON.stringify(next, null, 2)}\n`,
  };
}

/** Writes `.flisk/project.json`, and nothing else. The Tiltfile is never touched. */
export function applyTiltfileImport(plan: TiltfilePlan): void {
  mkdirSync(dirname(plan.projectJson), { recursive: true });
  writeFileSync(plan.projectJson, plan.content, plan.action === "create" ? { flag: "wx" } : {});
}

/** The printed plan for `flisk-import tiltfile`. */
export function formatTiltfilePlan(plan: TiltfilePlan): string {
  const status =
    plan.action === "create"
      ? "create Flisk project"
      : plan.replaced !== undefined
        ? `update, replaces orchestration (${describeOrchestration(plan.replaced)}) (--force)`
        : "update, other keys kept";
  return [
    `Found ${plan.orchestration.path} in ${plan.projectRoot}`,
    "The Tiltfile is not changed: flisk up runs it as it is.",
    "",
    `  .flisk/project.json  [${status}]`,
    `    orchestration:  ${JSON.stringify(plan.orchestration)}`,
    "",
  ].join("\n");
}
