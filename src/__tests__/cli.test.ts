import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function runComposeImport(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FLISK_IMPORT_DOCKER: "0" },
  });
}

it("reports the package version without importing a directory", () => {
  const result = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe(pkg.version);
  expect(result.stderr).toBe("");
});

it("lists --file in the Compose import help", () => {
  const result = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("--file <path>");
});

it("reads an explicit Compose file relative to the selected project directory", () => {
  const parent = mkdtempSync(join(tmpdir(), "flisk-import-file-cli-"));
  const root = join(parent, "shop");
  const elsewhere = join(parent, "elsewhere");
  try {
    mkdirSync(join(root, "deploy"), { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(
      join(root, "deploy", "compose.prod.yml"),
      "services:\n  chosen:\n    image: nginx\n",
    );
    writeFileSync(join(root, "docker-compose.yml"), "services:\n  ignored:\n    image: nginx\n");

    const result = runComposeImport(elsewhere, [
      root,
      "--file",
      "deploy/compose.prod.yml",
      "--dry-run",
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Read only: deploy/compose.prod.yml");
    expect(result.stdout).toContain("chosen");
    expect(result.stdout).not.toContain("ignored");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

it.each([
  ["missing.yml", "does not exist"],
  ["deploy", "is a directory"],
  ["../outside.yml", "must stay inside"],
])("refuses --file %s when it %s", (file, reason) => {
  const parent = mkdtempSync(join(tmpdir(), "flisk-import-file-cli-"));
  const root = join(parent, "shop");
  try {
    mkdirSync(join(root, "deploy"), { recursive: true });
    writeFileSync(join(parent, "outside.yml"), "services:\n  outside:\n    image: nginx\n");

    const result = runComposeImport(root, [".", "--file", file, "--dry-run"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(reason);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
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
