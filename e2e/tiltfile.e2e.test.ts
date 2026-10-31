import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const TILTFILE = "# my own Tiltfile\nlocal_resource('api', serve_cmd='bun run dev')\n";
let repo: string;

function run(args: string[], input?: string, cwd = repo) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", input });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const projectJsonPath = () => join(repo, ".flisk", "project.json");
const projectJson = () => JSON.parse(readFileSync(projectJsonPath(), "utf8"));

beforeEach(() => {
  repo = join(mkdtempSync(join(tmpdir(), "flisk-import-tiltfile-e2e-")), "shop");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "Tiltfile"), TILTFILE);
});
afterEach(() => rmSync(join(repo, ".."), { recursive: true, force: true }));

describe("flisk-import tiltfile (built CLI)", () => {
  it("--dry-run prints the plan, exits 0 and writes nothing", () => {
    const r = run(["tiltfile", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Found Tiltfile in");
    expect(r.out).toContain(".flisk/project.json  [create Flisk project]");
    expect(r.out).toContain('orchestration:  {"source":"tiltfile","path":"Tiltfile"}');
    expect(r.out).toContain("Dry run: nothing written.");
    expect(r.err).toBe("");
    expect(existsSync(join(repo, ".flisk"))).toBe(false);
  });

  it("--dry-run leaves an existing project.json byte for byte", () => {
    mkdirSync(join(repo, ".flisk"));
    writeFileSync(projectJsonPath(), '{"version":"1.0"}');
    const r = run(["tiltfile", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("[update, other keys kept]");
    expect(readFileSync(projectJsonPath(), "utf8")).toBe('{"version":"1.0"}');
  });

  it("--yes creates .flisk/project.json with the orchestration source and leaves the Tiltfile alone", () => {
    const before = statSync(join(repo, "Tiltfile")).mtimeMs;
    const r = run(["tiltfile", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("wrote .flisk/project.json");
    expect(r.out).toContain("Registered Tiltfile as the orchestration source.");
    expect(r.out).toContain("Next:");
    expect(r.out).toContain("flisk-sh/flisk#2849");
    expect(projectJson()).toMatchObject({
      version: "1.0",
      project: { name: "shop" },
      discovery: { paths: ["services/*/*"] },
      orchestration: { source: "tiltfile", path: "Tiltfile" },
    });
    expect(readFileSync(join(repo, "Tiltfile"), "utf8")).toBe(TILTFILE);
    expect(statSync(join(repo, "Tiltfile")).mtimeMs).toBe(before);
    expect(existsSync(join(repo, "services"))).toBe(false);
  });

  it("takes a directory or a file path, resolved from the cwd and written relative to the project root", () => {
    mkdirSync(join(repo, ".flisk"));
    writeFileSync(projectJsonPath(), `${JSON.stringify({ version: "1.0", keep: { me: 1 } })}\n`);
    mkdirSync(join(repo, "dev", "local"), { recursive: true });
    writeFileSync(join(repo, "dev", "local", "Tiltfile"), TILTFILE);

    const fromDir = run(["tiltfile", "local", "--yes"], undefined, join(repo, "dev"));
    expect(fromDir.code).toBe(0);
    expect(projectJson()).toEqual({
      version: "1.0",
      keep: { me: 1 },
      orchestration: { source: "tiltfile", path: "dev/local/Tiltfile" },
    });

    const fromFile = run(["tiltfile", "dev/local/Tiltfile", "--yes", "--force"]);
    expect(fromFile.code).toBe(0);
    expect(projectJson().orchestration.path).toBe("dev/local/Tiltfile");
  });

  it("refuses a missing Tiltfile with exit 1 and writes nothing", () => {
    rmSync(join(repo, "Tiltfile"));
    const r = run(["tiltfile", "--yes"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Error: No Tiltfile found at Tiltfile");
    expect(r.err).toContain("->");
    expect(existsSync(join(repo, ".flisk"))).toBe(false);

    const named = run(["tiltfile", "ops/Tiltfile", "--yes"]);
    expect(named.code).toBe(1);
    expect(named.err).toContain("No Tiltfile found at ops/Tiltfile");
  });

  it("refuses a path inside .flisk/ with exit 1", () => {
    mkdirSync(join(repo, ".flisk", ".flisk-out"), { recursive: true });
    writeFileSync(join(repo, ".flisk", ".flisk-out", "Tiltfile"), "# generated\n");
    const r = run(["tiltfile", ".flisk/.flisk-out/Tiltfile", "--yes"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("is inside .flisk/");
    expect(existsSync(projectJsonPath())).toBe(false);
  });

  it("refuses a path with a quote or a control character with exit 1", () => {
    for (const name of ['we"ird', "new\nline"]) {
      mkdirSync(join(repo, name));
      writeFileSync(join(repo, name, "Tiltfile"), TILTFILE);
      const r = run(["tiltfile", name, "--yes"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("has a quote or control character");
    }
    expect(existsSync(join(repo, ".flisk"))).toBe(false);
  });

  it("refuses an orchestration already set unless --force, which keeps every other key", () => {
    const existing = {
      version: "1.0",
      project: { name: "mine", version: "1.0.0" },
      orchestration: { source: "tiltfile", path: "old/Tiltfile" },
      overrides: { api: { port: 4100 } },
    };
    mkdirSync(join(repo, ".flisk"));
    writeFileSync(projectJsonPath(), JSON.stringify(existing));

    const refused = run(["tiltfile", "--yes"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("already sets orchestration (tiltfile: old/Tiltfile)");
    expect(refused.err).toContain("--force");
    expect(projectJson()).toEqual(existing);

    const forced = run(["tiltfile", "--yes", "--force"]);
    expect(forced.code).toBe(0);
    expect(forced.out).toContain("replaces orchestration (tiltfile: old/Tiltfile) (--force)");
    expect(projectJson()).toEqual({
      ...existing,
      orchestration: { source: "tiltfile", path: "Tiltfile" },
    });
  });

  it("asks before writing: no or a closed stdin exits 2 with Nothing written., yes or Enter writes", () => {
    const no = run(["tiltfile"], "n\n");
    expect(no.code).toBe(2);
    expect(no.out).toContain("Create .flisk/project.json with orchestration Tiltfile? (Y/n)");
    expect(no.out).toContain("Nothing written.");
    expect(existsSync(join(repo, ".flisk"))).toBe(false);

    const closed = run(["tiltfile"], "");
    expect(closed.code).toBe(2);
    expect(closed.out).toContain("Nothing written.");
    expect(existsSync(join(repo, ".flisk"))).toBe(false);

    const enter = run(["tiltfile"], "\n");
    expect(enter.code).toBe(0);
    expect(projectJson().orchestration).toEqual({ source: "tiltfile", path: "Tiltfile" });

    const yes = run(["tiltfile", "--force"], "y\n");
    expect(yes.code).toBe(0);
    expect(yes.out).toContain("Update .flisk/project.json with orchestration Tiltfile? (Y/n)");
  });

  it("honours the flags when they come before the subcommand", () => {
    const r = run(["--dry-run", "tiltfile"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Dry run: nothing written.");
    expect(existsSync(join(repo, ".flisk"))).toBe(false);
  });

  it("leaves plain flisk-import [dir] as the Compose import", () => {
    cpSync(join(import.meta.dirname, "fixtures", "shop"), join(repo, "app"), { recursive: true });
    const r = run(["app", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("docker-compose.yml [compose]");
    expect(r.out).not.toContain("orchestration");

    const noCompose = run(["--dry-run"]);
    expect(noCompose.code).toBe(1);
    expect(noCompose.err).toContain("No root docker-compose.yml found");
  });

  it("lists the subcommand in --help", () => {
    const r = run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("tiltfile [options] [path]");
  });
});
