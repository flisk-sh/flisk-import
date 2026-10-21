import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../detectors/procfile.js";
import { selectDetectors } from "../registry.js";

let root: string;

beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), "flisk-import-procfile-")), "app");
  mkdirSync(root, { recursive: true });
});

afterEach(() => rmSync(dirname(root), { recursive: true, force: true }));

describe("procfile detector", () => {
  it("claims Procfile and Procfile.<env> paths only", () => {
    const [detector] = selectDetectors(["procfile"]);
    if (!detector) throw new Error("procfile detector not registered");

    expect(detector.claim("Procfile")).toBe(true);
    expect(detector.claim("Procfile.dev")).toBe(true);
    expect(detector.claim("services/api/Procfile")).toBe(true);
    expect(detector.claim("procfile")).toBe(false);
    expect(detector.claim("Dockerfile")).toBe(false);
  });

  it("ignores blank and comment lines and parses web and worker processes with no port", () => {
    const absPath = join(root, "Procfile");
    writeFileSync(
      absPath,
      [
        "",
        "   ",
        "# main processes",
        "  # indented comment",
        "web: node server.js",
        "worker: node worker.js --queue default",
        "",
      ].join("\n"),
    );

    const [detector] = selectDetectors(["procfile"]);
    if (!detector) throw new Error("procfile detector not registered");
    const result = detector.parse(absPath, "Procfile");

    expect(result.skips).toEqual([]);
    expect(result.candidates).toEqual([
      {
        kind: "service",
        name: "web",
        dir: "",
        command: "node server.js",
        confidence: "high",
        sources: [{ file: "Procfile", detector: "procfile" }],
      },
      {
        kind: "service",
        name: "worker",
        dir: "",
        command: "node worker.js --queue default",
        confidence: "high",
        sources: [{ file: "Procfile", detector: "procfile" }],
      },
    ]);
    expect(result.candidates[0]?.port).toBeUndefined();
    expect(result.candidates[1]?.port).toBeUndefined();
  });

  it("maps release to a job and reports malformed or empty process lines as skips", () => {
    const absPath = join(root, "Procfile");
    writeFileSync(
      absPath,
      ["release: npm run migrate", "not a valid procfile line", "empty:", ""].join("\n"),
    );

    const [detector] = selectDetectors(["procfile"]);
    if (!detector) throw new Error("procfile detector not registered");
    const result = detector.parse(absPath, "api/Procfile");

    expect(result.candidates).toEqual([
      {
        kind: "job",
        name: "release",
        dir: "api",
        command: "npm run migrate",
        confidence: "high",
        sources: [{ file: "api/Procfile", detector: "procfile" }],
      },
    ]);
    expect(result.skips).toEqual([
      {
        file: "api/Procfile",
        detector: "procfile",
        line: 2,
        reason: "not a `name: command` line",
      },
      {
        file: "api/Procfile",
        detector: "procfile",
        line: 3,
        reason: 'process "empty" has no command',
      },
    ]);
  });
});
