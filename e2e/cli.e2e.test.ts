import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
let work: string;
let repo: string;

function run(args: string[], input?: string) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: work, encoding: "utf8", input });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const manifest = (name: string) =>
  JSON.parse(readFileSync(join(repo, "services", "shop", name, "service.json"), "utf8"));

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "flisk-import-e2e-"));
  repo = join(work, "shop");
  cpSync(join(import.meta.dirname, "fixtures", "shop"), repo, { recursive: true });
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe("flisk-import (built CLI)", () => {
  it("--dry-run prints the root Compose plan and writes nothing", () => {
    const r = run(["shop", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Found 2 service(s) and 0 job(s)");
    expect(r.out).toContain("docker-compose.yml [compose]");
    expect(r.out).toContain("depends:   db");
    expect(r.out).toContain("health:    /health");
    expect(r.out).toContain("Dry run: nothing written.");
    expect(existsSync(join(repo, "services"))).toBe(false);
    expect(existsSync(join(repo, ".flisk"))).toBe(false);
  });

  it("--yes writes one manifest per service, dependency wiring, project setup, and env values to the gitignored .env", () => {
    const r = run(["shop", "--yes"]);
    expect(r.code).toBe(0);
    expect(manifest("api")).toMatchObject({
      appType: "bring-your-own",
      stack: "shop",
      dependsOn: ["db"],
      buildContext: "../../../api",
      dockerfile: "Dockerfile",
      port: 4000,
      secrets: { required: ["DATABASE_URL"] },
      healthCheckPath: "/health",
    });
    // A "worker" ignores `image`; only bring-your-own runs the Compose image.
    expect(manifest("db")).toMatchObject({
      appType: "bring-your-own",
      image: "postgres:16",
      exposeViaProxy: false,
    });
    expect(manifest("db")).not.toHaveProperty("healthCheckPath");
    expect(r.out).toContain("Next:");
    expect(r.out).toContain("Copied 1 environment value(s) from docker-compose.yml to");
    expect(readFileSync(join(repo, ".env"), "utf8")).toContain(
      "DATABASE_URL=postgres://secret@db/app\n",
    );
    expect(readFileSync(join(repo, ".gitignore"), "utf8").split("\n")).toContain(".env");
    expect(r.out).toContain("Run `flisk up` with Flisk core 1.4.24 or later");
    expect(JSON.stringify(manifest("api"))).not.toContain("postgres://");
    expect(existsSync(join(repo, ".flisk", "project.json"))).toBe(true);
  });

  it("asks before writing and does not overwrite existing service.json without --force", () => {
    const file = join(repo, "services", "shop", "api", "service.json");
    mkdirSync(join(repo, "services", "shop", "api"), { recursive: true });
    writeFileSync(file, '{"userOwned":true}\n');
    const no = run(["shop"], "n\n");
    expect(no.code).toBe(2);
    expect(no.out).toContain("Nothing written.");
    expect(readFileSync(file, "utf8")).toBe('{"userOwned":true}\n');
    const yes = run(["shop"], "y\n");
    expect(yes.code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe('{"userOwned":true}\n');
  });

  it("prints Nothing written. and exits 2 when stdin is closed, and defaults to yes on an empty line", () => {
    const closed = run(["shop"], "");
    expect(closed.code).toBe(2);
    expect(closed.out).toContain("Nothing written.");
    expect(existsSync(join(repo, "services"))).toBe(false);

    const emptyAnswer = run(["shop"], "\n");
    expect(emptyAnswer.code).toBe(0);
    expect(existsSync(join(repo, "services", "shop", "api", "service.json"))).toBe(true);
  });

  it("requires the root docker-compose.yml and ignores nested files", () => {
    rmSync(join(repo, "docker-compose.yml"));
    const r = run(["shop", "--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("No root docker-compose.yml found");
    expect(existsSync(join(repo, "services"))).toBe(false);
  });

  it("reads compose.yaml when it is the only Compose file", () => {
    rmSync(join(repo, "docker-compose.yml"));
    writeFileSync(join(repo, "compose.yaml"), "services:\n  web:\n    image: nginx\n");
    const r = run(["shop", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Read only: compose.yaml");
    expect(existsSync(join(repo, "services"))).toBe(false);
  });

  it("lists Kustomize and Helm fixtures as skipped with their unsupported reasons", () => {
    cpSync(
      join(import.meta.dirname, "fixtures", "kustomize-only", "kustomization.yaml"),
      join(repo, "kustomization.yaml"),
    );
    cpSync(
      join(import.meta.dirname, "fixtures", "helm-only", "Chart.yaml"),
      join(repo, "Chart.yaml"),
    );
    const r = run(["shop", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("kustomization.yaml [unsupported]: Kustomize is not imported");
    expect(r.out).toContain("Chart.yaml [unsupported]: Helm is not imported");
  });
});
