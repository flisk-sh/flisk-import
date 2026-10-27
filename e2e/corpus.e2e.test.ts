import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXPECTATIONS } from "./corpus/expectations.js";

// Runs the built binary over every Compose file in e2e/corpus and checks what it wrote against what
// Flisk accepts (flisk cli/src/utils/service-manifest.ts) and against that fixture's expectations.
const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const CORPUS = join(import.meta.dirname, "corpus");
const HEALTH_PATH = /^\/[a-z0-9/-]*$/;
const IMAGE = /^[A-Za-z0-9._/:@-]+$/;
const names = readdirSync(CORPUS).filter((n) => statSync(join(CORPUS, n)).isDirectory());

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "flisk-import-corpus-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const run = (args: string[]) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: work, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const walk = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      )
    : [];
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

it("has an expectation for every fixture and a fixture for every expectation", () => {
  expect(names.sort()).toEqual(Object.keys(EXPECTATIONS).sort());
  expect(names.length).toBeGreaterThanOrEqual(24);
});

describe.each(names)("corpus: %s", (name) => {
  const want = () => EXPECTATIONS[name];
  const setup = () => {
    const repo = join(work, name);
    cpSync(join(CORPUS, name), repo, { recursive: true });
    return repo;
  };
  const manifests = (repo: string) =>
    Object.fromEntries(
      walk(join(repo, "services")).map((p) => [
        basename(dirname(p)),
        JSON.parse(readFileSync(p, "utf8")),
      ]),
    ) as Record<string, Record<string, unknown>>;

  it("--dry-run writes nothing and prints the plan", () => {
    const repo = setup();
    const r = run([name, "--dry-run"]);
    expect(r.code).toBe(want().exit ?? 0);
    expect(existsSync(join(repo, "services"))).toBe(false);
    expect(existsSync(join(repo, ".flisk"))).toBe(false);
    for (const text of want().plan ?? []) expect(r.out).toContain(text);
  });

  it("--yes writes manifests Flisk accepts, matching this fixture's expectations", () => {
    const repo = setup();
    const compose = sha(join(repo, "docker-compose.yml"));
    const r = run([name, "--yes"]);
    expect(r.code).toBe(want().exit ?? 0);
    for (const text of want().plan ?? []) expect(r.out).toContain(text);

    const written = manifests(repo);
    const expected = want().services ?? {};
    expect(Object.keys(written).sort()).toEqual(Object.keys(expected).sort());
    for (const svc of want().notWritten ?? []) expect(written).not.toHaveProperty(svc);
    for (const [svc, check] of Object.entries(expected)) {
      expect(written[svc], svc).toMatchObject(check.match ?? {});
      for (const field of check.without ?? [])
        expect(written[svc], `${svc}.${field}`).not.toHaveProperty(field);
    }

    for (const [svc, m] of Object.entries(written)) {
      expect(m.schemaVersion, svc).toBe(1);
      expect(m.appName, svc).toBe(svc);
      expect(m.stack, svc).toBe(name);
      expect(m.appType, svc).toBe("bring-your-own");
      expect(
        Number.isInteger(m.port) && (m.port as number) >= 1 && (m.port as number) <= 65535,
        `${svc} port`,
      ).toBe(true);
      if (m.healthCheckPath !== undefined)
        expect(m.healthCheckPath as string, svc).toMatch(HEALTH_PATH);
      // Exactly one source: an image, or a build context with its Dockerfile.
      const hasImage = m.image !== undefined;
      const hasBuild = m.buildContext !== undefined && m.dockerfile !== undefined;
      expect(hasImage !== hasBuild, `${svc} needs image xor build`).toBe(true);
      if (hasImage) expect(m.image as string, svc).toMatch(IMAGE);
      for (const dep of (m.dependsOn as string[] | undefined) ?? [])
        expect(Object.keys(written), `${svc} depends on a service that was not written`).toContain(
          dep,
        );
      // An unresolved Compose variable must never reach a value Flisk copies into generated config.
      const { $schema: _schema, ...fields } = m;
      expect(JSON.stringify(fields), svc).not.toContain("$");
    }

    // No environment value reaches disk, and the source Compose file is untouched.
    for (const file of [...walk(join(repo, "services")), ...walk(join(repo, ".flisk"))])
      expect(readFileSync(file, "utf8"), file).not.toContain("SECRET_TOKEN");
    expect(sha(join(repo, "docker-compose.yml"))).toBe(compose);
    if (Object.keys(expected).length > 0)
      expect(existsSync(join(repo, ".flisk", "project.json"))).toBe(true);
  });

  it("running --yes again keeps every file", () => {
    const repo = setup();
    if (!want().services) return;
    run([name, "--yes"]);
    const before = walk(repo).map((p) => [p, sha(p)]);
    const again = run([name, "--yes"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("Nothing to write: every service.json already exists.");
    expect(walk(repo).map((p) => [p, sha(p)])).toEqual(before);
  });
});
