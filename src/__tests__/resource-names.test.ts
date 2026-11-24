import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { buildPlan } from "../plan.js";
import { planWrites } from "../write.js";

it("writes valid, distinct appNames and keeps dependencies for long Compose service names", () => {
  const root = mkdtempSync(join(tmpdir(), "flisk-import-resource-names-"));
  vi.stubEnv("FLISK_IMPORT_DOCKER", "0");
  try {
    const existing = `${"a".repeat(63)}b`;
    const worker = `${existing}-worker`;
    const writer = `${existing}-writer`;
    const boundary = "z".repeat(63);
    const scheduler = `${boundary}-scheduler`;
    const workerName = `${"a".repeat(62)}-2`;
    const writerName = `${"a".repeat(62)}-3`;

    writeFileSync(
      join(root, "compose.yaml"),
      `services:
  ${writer}: { image: redis:7 }
  ${worker}: { image: redis:7 }
  ${existing}: { image: redis:7 }
  ${scheduler}: { image: redis:7 }
  web:
    image: nginx:1
    depends_on:
      ${worker}: { condition: service_started }
      ${writer}: { condition: service_healthy }
`,
    );

    const writes = planWrites(buildPlan(root), false);
    const manifests = new Map(
      writes.items.map(({ path, manifest }) => [basename(dirname(path)), manifest]),
    );
    expect(writes.rejected).toEqual([]);
    expect([...manifests.keys()].sort()).toEqual(
      [existing, workerName, writerName, boundary, "web"].sort(),
    );
    for (const [name, manifest] of manifests) expect(manifest.appName).toBe(name);
    expect(manifests.get(workerName)?.container).toMatchObject({ networkAliases: [worker] });
    expect(manifests.get(writerName)?.container).toMatchObject({ networkAliases: [writer] });
    expect(manifests.get("web")?.dependsOn).toEqual([
      { name: workerName, condition: "service_started" },
      { name: writerName, condition: "service_healthy" },
    ]);
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
