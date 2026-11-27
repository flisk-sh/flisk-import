import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../detectors/dockerfile.js";
import { formatPlan } from "../format.js";
import { mergeCandidates } from "../merge.js";
import type { ImportPlan } from "../plan.js";
import { selectDetectors } from "../registry.js";
import { planWrites } from "../write.js";

let root: string;

beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), "flisk-import-dockerfile-")), "app");
  mkdirSync(root, { recursive: true });
});

afterEach(() => rmSync(dirname(root), { recursive: true, force: true }));

function parseDockerfile(lines: string[]) {
  const absPath = join(root, "Dockerfile");
  writeFileSync(absPath, lines.join("\n"));
  const [detector] = selectDetectors(["dockerfile"]);
  if (!detector) throw new Error("dockerfile detector not registered");
  return detector.parse(absPath, "Dockerfile");
}

describe("dockerfile detector", () => {
  it("reports non-numeric EXPOSE in skips and plan output", () => {
    const result = parseDockerfile([
      "FROM node:22-alpine",
      `EXPOSE $${"{PORT}"}`,
      'CMD ["node", "server.js"]',
      "",
    ]);

    expect(result.candidates).toEqual([
      {
        kind: "service",
        dir: "",
        dockerfile: "Dockerfile",
        command: "node server.js",
        confidence: "high",
        sources: [{ file: "Dockerfile", detector: "dockerfile" }],
      },
    ]);
    expect(result.skips).toEqual([
      {
        file: "Dockerfile",
        detector: "dockerfile",
        line: 2,
        reason: "EXPOSE uses a variable; port not imported",
      },
    ]);

    const merged = mergeCandidates(result.candidates, "app");
    const plan: ImportPlan = {
      root,
      services: merged.services,
      skips: [...result.skips, ...merged.skips],
      unsupported: [],
      skippedProcfileProcesses: 0,
      notes: [],
      files: ["Dockerfile"],
    };
    const text = formatPlan(plan, planWrites(plan, false));
    expect(text).toContain("Dockerfile:2 [dockerfile]: EXPOSE uses a variable; port not imported");
  });

  it("imports EXPOSE and CMD when only the final stage defines them", () => {
    const result = parseDockerfile([
      "FROM node:22 AS builder",
      "RUN npm ci && npm run build",
      "FROM node:22-slim",
      "EXPOSE 4000/tcp",
      'CMD ["node", "dist/index.js"]',
      "",
    ]);

    expect(result.skips).toEqual([]);
    expect(result.candidates[0]).toMatchObject({
      port: 4000,
      command: "node dist/index.js",
    });
  });

  it("combines an exec ENTRYPOINT and exec CMD as Docker does", () => {
    const result = parseDockerfile([
      "FROM node:22-alpine",
      'ENTRYPOINT ["node", "--inspect"]',
      'CMD ["server.js", "--port", "4000"]',
      "",
    ]);

    expect(result.candidates[0]?.command).toBe("node --inspect server.js --port 4000");
  });

  it("imports an exec ENTRYPOINT when there is no CMD", () => {
    const result = parseDockerfile(["FROM node:22-alpine", 'ENTRYPOINT ["node", "server.js"]', ""]);

    expect(result.candidates[0]?.command).toBe("node server.js");
  });

  it("imports a shell ENTRYPOINT with and without CMD as Docker runs it", () => {
    const withoutCmd = parseDockerfile(["FROM node:22-alpine", "ENTRYPOINT node server.js", ""]);
    expect(withoutCmd.candidates[0]?.command).toBe("node server.js");

    const withCmd = parseDockerfile([
      "FROM node:22-alpine",
      "ENTRYPOINT node --trace-warnings",
      'CMD ["server.js"]',
      "",
    ]);
    expect(withCmd.candidates[0]?.command).toBe("node --trace-warnings");
  });

  it("keeps a shell CMD as written when there is no ENTRYPOINT", () => {
    const result = parseDockerfile(["FROM node:22-alpine", "CMD node server.js --watch", ""]);

    expect(result.candidates[0]?.command).toBe("node server.js --watch");
  });

  it("passes a shell CMD to an exec ENTRYPOINT through the shell Docker adds", () => {
    const result = parseDockerfile([
      "FROM node:22-alpine",
      'ENTRYPOINT ["node"]',
      "CMD server.js --watch",
      "",
    ]);

    expect(result.candidates[0]?.command).toBe("node /bin/sh -c server.js --watch");
  });

  it("resets ENTRYPOINT on each FROM so an earlier stage is not prepended", () => {
    const result = parseDockerfile([
      "FROM node:22 AS builder",
      'ENTRYPOINT ["npm", "run", "build"]',
      "FROM node:22-slim",
      'CMD ["node", "dist/index.js"]',
      "",
    ]);

    expect(result.candidates[0]?.command).toBe("node dist/index.js");
  });

  it("resets ports, command, and skips on each FROM so earlier stages do not leak into the final stage", () => {
    const overridden = parseDockerfile([
      "FROM node:22 AS builder",
      "EXPOSE 3000",
      `EXPOSE $${"{BUILD_PORT}"}`,
      'CMD ["npm", "run", "build"]',
      "FROM node:22-slim",
      "EXPOSE 4000/tcp",
      'CMD ["node", "dist/index.js"]',
      "",
    ]);
    expect(overridden.skips).toEqual([]);
    expect(overridden.candidates[0]).toMatchObject({
      port: 4000,
      command: "node dist/index.js",
    });

    const cleared = parseDockerfile([
      "FROM node:22 AS builder",
      "EXPOSE 3000",
      'ENTRYPOINT ["npm", "run", "build"]',
      'CMD ["npm", "run", "build"]',
      "FROM nginx:alpine",
      "",
    ]);
    expect(cleared.skips).toEqual([]);
    expect(cleared.candidates[0]?.port).toBeUndefined();
    expect(cleared.candidates[0]?.command).toBeUndefined();
  });
});
