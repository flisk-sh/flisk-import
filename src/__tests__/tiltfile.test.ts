import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImportError } from "../errors.js";
import { defaultProjectConfig, missingProjectFields } from "../flisk.js";
import { buildPlan } from "../plan.js";
import {
  applyTiltfileImport,
  formatTiltfilePlan,
  planTiltfileImport,
  type TiltfilePlan,
} from "../tiltfile.js";
import { planWrites } from "../write.js";

let root: string;

function tree(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

/** A `.flisk/project.json` that Flisk core reads, with `extra` keys on top. */
const valid = (extra: Record<string, unknown> = {}) => ({
  ...defaultProjectConfig("mine", { description: "", enabledStacks: [] }),
  ...extra,
});
const validJson = (extra: Record<string, unknown> = {}) => JSON.stringify(valid(extra));

const projectJson = () => JSON.parse(readFileSync(join(root, ".flisk", "project.json"), "utf8"));

function refusal(fn: () => unknown): ImportError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ImportError);
    return err as ImportError;
  }
  throw new Error("expected an ImportError");
}

beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), "flisk-import-tiltfile-")), "shop");
  mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(dirname(root), { recursive: true, force: true }));

describe("planTiltfileImport", () => {
  it("defaults to ./Tiltfile and plans a new .flisk/project.json shaped like the Compose import's", () => {
    tree({
      Tiltfile: "print('hi')\n",
      "docker-compose.yml": "services:\n  web:\n    image: nginx\n",
    });
    const plan = planTiltfileImport(undefined, { cwd: root });
    expect(plan).toMatchObject({
      tiltfile: join(root, "Tiltfile"),
      projectRoot: root,
      projectJson: join(root, ".flisk", "project.json"),
      orchestration: { source: "tiltfile", path: "Tiltfile" },
      action: "create",
    });
    expect(existsSync(join(root, ".flisk"))).toBe(false);

    const created = JSON.parse(plan.content);
    const compose = planWrites(buildPlan(root), false).projectConfig;
    const composeConfig = JSON.parse(compose?.content ?? "{}");
    // Same template, without an imported Compose stack, plus the orchestration source.
    // composeProjectNames is the Compose import's own record of the Compose project name.
    expect(Object.keys(created)).toEqual([
      ...Object.keys(composeConfig).filter((key) => key !== "composeProjectNames"),
      "orchestration",
    ]);
    expect(created.project).toEqual({ name: "shop", version: "1.0.0" });
    expect(created.phases.pre_alpha.enabledStacks).toEqual(["proxy"]);
    expect(created.discovery).toEqual(composeConfig.discovery);
    expect(created.orchestration).toEqual({ source: "tiltfile", path: "Tiltfile" });
  });

  it("reads <dir>/Tiltfile when the path is a directory, with a forward-slash path from the root", () => {
    tree({ "dev/local/Tiltfile": "print('hi')\n" });
    expect(planTiltfileImport("dev/local", { cwd: root }).orchestration).toEqual({
      source: "tiltfile",
      path: "dev/local/Tiltfile",
    });
    expect(planTiltfileImport("dev/local/Tiltfile", { cwd: root }).orchestration.path).toBe(
      "dev/local/Tiltfile",
    );
  });

  it("keeps a Tiltfile with another name", () => {
    tree({ "Tiltfile.dev": "print('hi')\n" });
    expect(planTiltfileImport("Tiltfile.dev", { cwd: root }).orchestration.path).toBe(
      "Tiltfile.dev",
    );
  });

  it("uses the nearest folder with .flisk/project.json as the root, and the path stays relative to it", () => {
    tree({ ".flisk/project.json": validJson(), "apps/web/Tiltfile": "print('hi')\n" });
    const plan = planTiltfileImport("Tiltfile", { cwd: join(root, "apps", "web") });
    expect(plan.projectRoot).toBe(root);
    expect(plan.action).toBe("update");
    expect(plan.orchestration.path).toBe("apps/web/Tiltfile");
  });

  it("uses the working directory as the root when no project.json is above it", () => {
    tree({ "apps/web/Tiltfile": "print('hi')\n" });
    const plan = planTiltfileImport(undefined, { cwd: join(root, "apps", "web") });
    expect(plan.projectRoot).toBe(join(root, "apps", "web"));
    expect(plan.orchestration.path).toBe("Tiltfile");
  });

  it("refuses a missing Tiltfile, default or named, and a folder without one", () => {
    mkdirSync(join(root, "empty"));
    expect(refusal(() => planTiltfileImport(undefined, { cwd: root })).message).toBe(
      "No Tiltfile found at Tiltfile",
    );
    expect(refusal(() => planTiltfileImport("dev/Tiltfile", { cwd: root })).message).toBe(
      "No Tiltfile found at dev/Tiltfile",
    );
    expect(refusal(() => planTiltfileImport("empty", { cwd: root })).message).toBe(
      "No Tiltfile found at empty",
    );
  });

  it("refuses a path inside .flisk/, such as the Tiltfile Flisk generates", () => {
    tree({ ".flisk/.flisk-out/Tiltfile": "# generated\n" });
    const err = refusal(() => planTiltfileImport(".flisk/.flisk-out/Tiltfile", { cwd: root }));
    expect(err.message).toContain(".flisk/.flisk-out/Tiltfile is inside .flisk/");
    expect(refusal(() => planTiltfileImport(".flisk/.flisk-out", { cwd: root })).message).toContain(
      "is inside .flisk/",
    );
  });

  it.each([
    ['dev"/Tiltfile', "a double quote"],
    ["dev'/Tiltfile", "a single quote"],
    ["dev\n/Tiltfile", "a newline"],
    ["dev\t/Tiltfile", "a tab"],
  ])("refuses a path with %j (%s)", (path) => {
    tree({ [path]: "print('hi')\n" });
    expect(refusal(() => planTiltfileImport(path, { cwd: root })).message).toContain(
      "has a quote or control character",
    );
  });

  it("refuses an orchestration already set, and --force replaces it in place keeping every other key", () => {
    const existing = valid({
      project: { name: "mine", version: "2.0.0" },
      orchestration: { source: "tiltfile", path: "old/Tiltfile" },
      custom: { kept: true },
    });
    tree({ Tiltfile: "print('hi')\n", ".flisk/project.json": JSON.stringify(existing) });
    const err = refusal(() => planTiltfileImport(undefined, { cwd: root }));
    expect(err.message).toBe(
      ".flisk/project.json already sets orchestration (tiltfile: old/Tiltfile)",
    );
    expect(err.suggestions.join(" ")).toContain("--force");

    const plan = planTiltfileImport(undefined, { cwd: root, force: true });
    expect(plan.replaced).toEqual(existing.orchestration);
    const next = JSON.parse(plan.content);
    expect(next).toEqual({ ...existing, orchestration: { source: "tiltfile", path: "Tiltfile" } });
    expect(Object.keys(next)).toEqual(Object.keys(existing));
  });

  it("refuses any orchestration value, not only a Tiltfile one", () => {
    tree({
      Tiltfile: "x\n",
      ".flisk/project.json": validJson({ orchestration: { source: "generated" } }),
    });
    expect(refusal(() => planTiltfileImport(undefined, { cwd: root })).message).toContain(
      "(generated: default)",
    );
  });

  it("refuses a project.json that is not a JSON object, with a hint", () => {
    tree({ Tiltfile: "x\n", ".flisk/project.json": "{ not json" });
    const notJson = refusal(() => planTiltfileImport(undefined, { cwd: root }));
    expect(notJson.message).toContain("Cannot read");
    expect(notJson.suggestions.join(" ")).toContain("flisk project --yes --force");
    for (const content of ["[]\n", '"text"\n', "null\n", "42\n"]) {
      writeFileSync(join(root, ".flisk", "project.json"), content);
      const err = refusal(() => planTiltfileImport(undefined, { cwd: root }));
      expect(err.message).toContain("is not a JSON object");
      expect(err.suggestions.length).toBeGreaterThan(0);
    }
  });

  it("refuses a project.json without the fields flisk up needs, naming them, before any write", () => {
    tree({ Tiltfile: "x\n", ".flisk/project.json": '{"version":"1.0"}\n' });
    const err = refusal(() => planTiltfileImport(undefined, { cwd: root }));
    expect(err.message).toBe(
      ".flisk/project.json is missing fields flisk up needs, or has them with the wrong type: project, phases, optional_infra, discovery",
    );
    expect(err.suggestions).toHaveLength(2);
    expect(err.suggestions[0]).toContain("Add them to .flisk/project.json");
    expect(err.suggestions[1]).toContain("flisk project --yes --force");
    expect(readFileSync(join(root, ".flisk", "project.json"), "utf8")).toBe('{"version":"1.0"}\n');

    // --force replaces orchestration only; it does not skip the check.
    writeFileSync(
      join(root, ".flisk", "project.json"),
      JSON.stringify({ ...valid({ orchestration: { source: "generated" } }), discovery: {} }),
    );
    expect(
      refusal(() => planTiltfileImport(undefined, { cwd: root, force: true })).message,
    ).toMatch(/: discovery\.paths$/);
  });

  it("refuses a Tiltfile that is a symlink into .flisk/", () => {
    tree({ ".flisk/.flisk-out/Tiltfile": "# generated\n", "infra/.keep": "" });
    symlinkSync(join("..", ".flisk", ".flisk-out", "Tiltfile"), join(root, "infra", "Tiltfile"));
    const err = refusal(() => planTiltfileImport("infra/Tiltfile", { cwd: root }));
    expect(err.message).toBe(
      "infra/Tiltfile is inside .flisk/ (it resolves to .flisk/.flisk-out/Tiltfile), where Flisk writes its generated files; import your own Tiltfile instead",
    );
    expect(err.suggestions).toEqual([
      "Point it at the Tiltfile you maintain: flisk import tiltfile <path>",
    ]);
    expect(refusal(() => planTiltfileImport("infra", { cwd: root })).message).toContain(
      "is inside .flisk/",
    );
  });

  it("refuses a folder symlinked into .flisk/, and a Tiltfile under a symlinked .flisk/", () => {
    tree({ ".flisk/.flisk-out/Tiltfile": "# generated\n" });
    symlinkSync(join(".flisk", ".flisk-out"), join(root, "ops"));
    expect(refusal(() => planTiltfileImport("ops", { cwd: root })).message).toContain(
      "ops/Tiltfile is inside .flisk/ (it resolves to .flisk/.flisk-out/Tiltfile)",
    );

    // .flisk/ itself a link: a Tiltfile reached through its target, not through .flisk/, is still inside it.
    const state = join(dirname(root), "state");
    mkdirSync(join(state, ".flisk-out"), { recursive: true });
    writeFileSync(join(state, ".flisk-out", "Tiltfile"), "# generated\n");
    rmSync(join(root, ".flisk"), { recursive: true });
    symlinkSync(state, join(root, ".flisk"));
    symlinkSync(join(state, ".flisk-out", "Tiltfile"), join(root, "Tiltfile"));
    expect(refusal(() => planTiltfileImport(undefined, { cwd: root })).message).toContain(
      "Tiltfile is inside .flisk/ (it resolves to .flisk/.flisk-out/Tiltfile)",
    );
  });

  it("accepts a symlink to a Tiltfile outside .flisk/, and a Tiltfile when the root itself is reached through a link", () => {
    tree({ "shared/Tiltfile": "print('hi')\n", ".flisk/project.json": validJson() });
    symlinkSync(join("shared", "Tiltfile"), join(root, "Tiltfile"));
    expect(planTiltfileImport(undefined, { cwd: root }).orchestration.path).toBe("Tiltfile");

    const linkedRoot = join(dirname(root), "linked");
    symlinkSync(root, linkedRoot);
    expect(planTiltfileImport("shared", { cwd: linkedRoot }).orchestration.path).toBe(
      "shared/Tiltfile",
    );
  });
});

describe("missingProjectFields", () => {
  it("is empty for the project.json the imports create, and for core's older stacks shape", () => {
    expect(missingProjectFields(valid())).toEqual([]);
    const { phases: _phases, ...rest } = valid();
    const stacks = Object.fromEntries(
      ["pre_alpha", "alpha", "beta", "out_of_scope"].map((p) => [p, { name: p, services: [] }]),
    );
    expect(missingProjectFields({ ...rest, stacks })).toEqual([]);
  });

  it("names each missing or mistyped field, and a whole missing object once", () => {
    expect(missingProjectFields({})).toEqual([
      "version",
      "project",
      "phases",
      "optional_infra",
      "discovery",
    ]);
    expect(
      missingProjectFields({
        ...valid(),
        version: 1,
        project: { name: "shop" },
        phases: { ...(valid().phases as object), beta: { enabledStacks: "x" } },
        optional_infra: { ...(valid().optional_infra as object), elk: "false" },
        discovery: { paths: "services/*/*" },
        capabilities: { gateway: "false" },
      }),
    ).toEqual([
      "version",
      "project.version",
      "phases.beta.enabledStacks",
      "optional_infra.elk",
      "discovery.paths",
      "capabilities",
    ]);
    expect(missingProjectFields({ ...valid(), capabilities: { gateway: false } })).toEqual([]);
  });
});

describe("applyTiltfileImport", () => {
  it("writes .flisk/project.json and never the Tiltfile", () => {
    const tiltfile = "# my own Tiltfile\nlocal_resource('api', serve_cmd='bun run dev')\n";
    tree({ Tiltfile: tiltfile });
    applyTiltfileImport(planTiltfileImport(undefined, { cwd: root }));
    expect(projectJson().orchestration).toEqual({ source: "tiltfile", path: "Tiltfile" });
    expect(readFileSync(join(root, "Tiltfile"), "utf8")).toBe(tiltfile);
  });

  it("adds orchestration to an existing project.json and keeps every other key", () => {
    const existing = valid({ overrides: { a: 1 }, extra: [1] });
    tree({ Tiltfile: "x\n", ".flisk/project.json": JSON.stringify(existing) });
    applyTiltfileImport(planTiltfileImport(undefined, { cwd: root }));
    expect(projectJson()).toEqual({
      ...existing,
      orchestration: { source: "tiltfile", path: "Tiltfile" },
    });
  });

  it("does not overwrite a project.json created after a create plan was made", () => {
    tree({ Tiltfile: "x\n" });
    const plan: TiltfilePlan = planTiltfileImport(undefined, { cwd: root });
    tree({ ".flisk/project.json": '{"mine":true}\n' });
    expect(() => applyTiltfileImport(plan)).toThrow();
    expect(projectJson()).toEqual({ mine: true });
  });
});

describe("formatTiltfilePlan", () => {
  it("names the Tiltfile, the root and what happens to project.json", () => {
    tree({ Tiltfile: "x\n" });
    const text = formatTiltfilePlan(planTiltfileImport(undefined, { cwd: root }));
    expect(text).toContain(`Found Tiltfile in ${root}`);
    expect(text).toContain("The Tiltfile is not changed");
    expect(text).toContain(".flisk/project.json  [create Flisk project]");
    expect(text).toContain('orchestration:  {"source":"tiltfile","path":"Tiltfile"}');

    tree({
      ".flisk/project.json": validJson({ orchestration: { source: "tiltfile", path: "old" } }),
    });
    expect(formatTiltfilePlan(planTiltfileImport(undefined, { cwd: root, force: true }))).toContain(
      "[update, replaces orchestration (tiltfile: old) (--force)]",
    );
    writeFileSync(join(root, ".flisk", "project.json"), validJson());
    expect(formatTiltfilePlan(planTiltfileImport(undefined, { cwd: root }))).toContain(
      "[update, other keys kept]",
    );
  });
});
