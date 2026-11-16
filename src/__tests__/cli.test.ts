import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

function runTiltfileImport(cwd: string) {
  return spawnSync(process.execPath, [cli, "tiltfile", "--yes"], {
    cwd,
    encoding: "utf8",
  });
}

it("reports the package version without importing a directory", () => {
  const result = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe(pkg.version);
  expect(result.stderr).toBe("");
});

it("treats an identical Tiltfile re-import as a successful no-op", () => {
  const root = mkdtempSync(join(tmpdir(), "flisk-import-tiltfile-cli-"));
  try {
    writeFileSync(join(root, "Tiltfile"), "print('hello')\n");
    expect(runTiltfileImport(root).status).toBe(0);

    const projectJson = join(root, ".flisk", "project.json");
    const before = readFileSync(projectJson);
    const repeated = runTiltfileImport(root);

    expect(repeated.status).toBe(0);
    expect(repeated.stdout).toContain("Nothing to write");
    expect(readFileSync(projectJson)).toEqual(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("still refuses a different existing orchestration without --force", () => {
  const root = mkdtempSync(join(tmpdir(), "flisk-import-tiltfile-cli-"));
  try {
    writeFileSync(join(root, "Tiltfile"), "print('hello')\n");
    expect(runTiltfileImport(root).status).toBe(0);

    const projectJson = join(root, ".flisk", "project.json");
    const config = JSON.parse(readFileSync(projectJson, "utf8"));
    config.orchestration.path = "dev/Tiltfile";
    writeFileSync(projectJson, `${JSON.stringify(config, null, 2)}\n`);
    const before = readFileSync(projectJson);
    const repeated = runTiltfileImport(root);

    expect(repeated.status).toBe(1);
    expect(repeated.stderr).toContain("already sets orchestration");
    expect(repeated.stderr).toContain("Pass --force");
    expect(readFileSync(projectJson)).toEqual(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
