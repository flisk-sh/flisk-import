import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../detectors/package-json.js";
import { selectDetectors } from "../registry.js";

let root: string;

beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), "flisk-import-package-json-")), "app");
  mkdirSync(root, { recursive: true });
});

afterEach(() => rmSync(dirname(root), { recursive: true, force: true }));

describe("package-json detector", () => {
  it("claims package.json paths only", () => {
    const [detector] = selectDetectors(["package-json"]);
    if (!detector) throw new Error("package-json detector not registered");

    expect(detector.claim("package.json")).toBe(true);
    expect(detector.claim("apps/web/package.json")).toBe(true);
    expect(detector.claim("package-lock.json")).toBe(false);
    expect(detector.claim("tsconfig.json")).toBe(false);
  });

  it("produces a service candidate from a start script and detects the node runtime", () => {
    const absPath = join(root, "package.json");
    writeFileSync(
      absPath,
      JSON.stringify({
        name: "api",
        scripts: {
          start: "NODE_ENV=production node dist/server.js",
          dev: "tsx watch src/server.ts",
        },
      }),
    );

    const [detector] = selectDetectors(["package-json"]);
    if (!detector) throw new Error("package-json detector not registered");
    const result = detector.parse(absPath, "package.json");

    expect(result.skips).toEqual([]);
    expect(result.candidates).toEqual([
      {
        kind: "service",
        dir: "",
        command: "NODE_ENV=production node dist/server.js",
        language: "node",
        confidence: "high",
        sources: [{ file: "package.json", detector: "package-json" }],
      },
    ]);
  });

  it("falls back to a dev script when start is absent", () => {
    const absPath = join(root, "package.json");
    writeFileSync(
      absPath,
      JSON.stringify({
        name: "web",
        scripts: {
          dev: "vite dev",
        },
      }),
    );

    const [detector] = selectDetectors(["package-json"]);
    if (!detector) throw new Error("package-json detector not registered");
    const result = detector.parse(absPath, "apps/web/package.json");

    expect(result.skips).toEqual([]);
    expect(result.candidates).toEqual([
      {
        kind: "service",
        dir: "apps/web",
        command: "vite dev",
        confidence: "low",
        sources: [{ file: "apps/web/package.json", detector: "package-json" }],
      },
    ]);
  });

  it("produces a skip when package.json has no scripts or no start/dev script", () => {
    const absPath = join(root, "package.json");
    const [detector] = selectDetectors(["package-json"]);
    if (!detector) throw new Error("package-json detector not registered");

    writeFileSync(absPath, JSON.stringify({ name: "lib" }));
    expect(detector.parse(absPath, "package.json")).toEqual({
      candidates: [],
      skips: [
        {
          file: "package.json",
          detector: "package-json",
          reason: "no `start` or `dev` script",
        },
      ],
    });

    writeFileSync(absPath, JSON.stringify({ name: "lib", scripts: { test: "vitest" } }));
    expect(detector.parse(absPath, "package.json")).toEqual({
      candidates: [],
      skips: [
        {
          file: "package.json",
          detector: "package-json",
          reason: "no `start` or `dev` script",
        },
      ],
    });
  });

  it("produces an invalid JSON skip when package.json is malformed", () => {
    const absPath = join(root, "package.json");
    writeFileSync(absPath, "{ invalid json");

    const [detector] = selectDetectors(["package-json"]);
    if (!detector) throw new Error("package-json detector not registered");
    const result = detector.parse(absPath, "package.json");

    expect(result.candidates).toEqual([]);
    expect(result.skips).toHaveLength(1);
    expect(result.skips[0]).toMatchObject({
      file: "package.json",
      detector: "package-json",
    });
    expect(result.skips[0]?.reason).toMatch(/^invalid JSON:/);
  });
});
