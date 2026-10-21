import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatPlan } from "../format.js";
import { buildPlan } from "../plan.js";
import { applyWrites, planWrites } from "../write.js";

let root: string;

function tree(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), "flisk-import-")), "shop");
  mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(dirname(root), { recursive: true, force: true }));

const serviceJson = (name: string) => join(root, "services", "shop", name, "service.json");

describe("root Compose import", () => {
  const compose = [
    "services:",
    "  api:",
    "    build:",
    "      context: ./api",
    "      dockerfile: Dockerfile",
    "    ports: ['4000:4000']",
    "    environment:",
    "      DATABASE_URL: postgres://user:secret@db/app",
    "    depends_on: [db]",
    "    healthcheck:",
    "      test: ['CMD-SHELL', 'curl -f http://localhost:4000/health || exit 1']",
    "  db:",
    "    image: example.invalid/database:latest",
    "    ports: ['5432:5432']",
  ].join("\n");

  it("reads only root docker-compose.yml and plans one entry per Compose service", () => {
    tree({
      "docker-compose.yml": compose,
      "nested/docker-compose.yml": "services:\n  ignored:\n    image: nginx\n",
      "api/Dockerfile": "FROM node:22\n",
      "package.json": '{"scripts":{"start":"node app.js"}}',
      Procfile: "web: node app.js\n",
    });
    const plan = buildPlan(root);
    expect(plan.files).toEqual(["docker-compose.yml"]);
    expect(plan.services.map((s) => s.name).sort()).toEqual(["api", "db-svc"]);
    expect(plan.services.find((s) => s.name === "api")).toMatchObject({
      dir: "api",
      dockerfile: "Dockerfile",
      port: 4000,
      healthCheckPath: "/health",
      dependsOn: ["db-svc"],
    });
    expect(plan.services.map((s) => s.name)).not.toContain("ignored");
  });

  it("prints a plan without writing and writes manifests plus project config only when applied", () => {
    tree({ "docker-compose.yml": compose });
    const plan = buildPlan(root);
    const writes = planWrites(plan, false);
    expect(formatPlan(plan, writes)).toContain("depends:   db");
    expect(formatPlan(plan, writes)).toContain(".tdk/project.json  [create TDK project]");
    expect(existsSync(join(root, "services"))).toBe(false);
    expect(existsSync(join(root, ".tdk"))).toBe(false);

    applyWrites(writes);
    const api = JSON.parse(readFileSync(serviceJson("api"), "utf8"));
    const db = JSON.parse(readFileSync(serviceJson("db-svc"), "utf8"));
    expect(api).toMatchObject({
      stack: "shop",
      appType: "bring-your-own",
      port: 4000,
      healthCheckPath: "/health",
      dependsOn: ["db-svc"],
      buildContext: "../../../api",
      dockerfile: "Dockerfile",
    });
    expect(db).toMatchObject({
      image: "example.invalid/database:latest",
      appType: "bring-your-own",
      exposeViaProxy: false,
      port: 5432,
    });
    expect(readFileSync(serviceJson("api"), "utf8")).not.toContain("postgres://");
    expect(
      JSON.parse(readFileSync(join(root, ".tdk", "project.json"), "utf8")).phases.pre_alpha
        .enabledStacks,
    ).toContain("shop");
  });

  it("never overwrites existing service.json without force", () => {
    tree({ "docker-compose.yml": compose });
    const file = serviceJson("api");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{"userOwned":true}\n');
    const writes = planWrites(buildPlan(root), false);
    expect(writes.items.find((i) => i.service.name === "api")?.status).toBe("exists");
    applyWrites(writes);
    expect(readFileSync(file, "utf8")).toBe('{"userOwned":true}\n');
  });

  it("refuses a missing root docker-compose.yml instead of walking for other inputs", () => {
    tree({
      "nested/docker-compose.yml": compose,
      Dockerfile: "FROM nginx\n",
      "package.json": '{"scripts":{"start":"node app.js"}}',
    });
    expect(() => buildPlan(root)).toThrow(/No root docker-compose.yml found/);
  });

  it("names Compose files that docker compose would use but the importer does not read", () => {
    tree({
      "docker-compose.yml": compose,
      "docker-compose.override.yml": "services:\n  api:\n    ports: ['9000:4000']\n",
      "compose.yaml": "services:\n  other:\n    image: nginx\n",
    });
    const text = formatPlan(buildPlan(root), planWrites(buildPlan(root), false));
    expect(text).toContain("docker-compose.override.yml [compose]: not applied");
    expect(text).toContain("compose.yaml [compose]: not read; `docker compose` prefers it");
    expect(text).not.toContain("other");
  });

  it("reports Helm Chart.yaml and both kustomization.yaml and kustomization.yml as unsupported skips", () => {
    tree({
      "docker-compose.yml": compose,
      "Chart.yaml": "apiVersion: v2\n",
      "kustomization.yaml": "kind: Kustomization\n",
      "overlays/dev/kustomization.yml": "kind: Kustomization\n",
    });
    const plan = buildPlan(root);
    expect(plan.unsupported).toEqual(["Helm", "Kustomize"]);
    const text = formatPlan(plan, planWrites(plan, false));
    expect(text).toContain("Chart.yaml [unsupported]: Helm is not imported");
    expect(text).toContain("kustomization.yaml [unsupported]: Kustomize is not imported");
    expect(text).toContain(
      "overlays/dev/kustomization.yml [unsupported]: Kustomize is not imported",
    );
  });
});

describe("Compose values TDK cannot take as they are", () => {
  const plan = (yaml: string) => {
    tree({ "docker-compose.yml": yaml });
    const p = buildPlan(root);
    const writes = planWrites(p, false);
    const manifest = (name: string) =>
      writes.items.find((i) => i.service.name === name)?.manifest as Record<string, unknown>;
    return { p, writes, manifest, text: formatPlan(p, writes) };
  };

  it("routes an HTTP service on 8080 and assigns an in-range port", () => {
    const { manifest, text } = plan(
      "services:\n  web:\n    image: example/web:1\n    ports: ['80:8080']\n",
    );
    expect(manifest("web")).toMatchObject({
      appType: "bring-your-own",
      port: 4000,
      healthCheckPath: "/",
    });
    expect(manifest("web")).not.toHaveProperty("exposeViaProxy");
    expect(text).toContain("proxy:     routed through Traefik");
    expect(text).toContain("health:    / (assumed)");
    expect(text).toContain(
      "Compose port 8080 is outside 4000-5999 or already used; assigned 4000. The container must listen on $PORT (4000)",
    );
  });

  it("assigns a port for a privileged Compose port and says the container must read PORT", () => {
    const { manifest, text } = plan(
      "services:\n  web:\n    image: nginx:1.27\n    ports: ['8080:80']\n",
    );
    expect(manifest("web").port).toBe(4000);
    expect(text).toContain(
      "Compose port 80 is outside 4000-5999 or already used; assigned 4000. The container must listen on $PORT (4000)",
    );
  });

  it("builds from the Dockerfile when Compose gives both build and image, and notes that image is not written", () => {
    tree({ "api/Dockerfile": "FROM busybox\n" });
    const { manifest, text } = plan(
      "services:\n  api:\n    build: ./api\n    image: example/api:dev\n    ports: ['4000:4000']\n",
    );
    expect(manifest("api")).toMatchObject({
      buildContext: "../../../api",
      dockerfile: "Dockerfile",
    });
    expect(manifest("api")).not.toHaveProperty("image");
    expect(text).toContain(
      'note:      image "example/api:dev" is not written: with build and image, TDK builds from Dockerfile and does not pull the tag',
    );
  });

  it("does not write an interpolated image, and drops dependencies on it", () => {
    const { writes, manifest, text } = plan(
      [
        "services:",
        "  api:",
        "    image: example/api:1",
        "    ports: ['4000:4000']",
        "    depends_on: [db]",
        "  db:",
        "    image: postgres:${PG_VERSION:-16}",
        "    ports: ['5432:5432']",
      ].join("\n"),
    );
    expect(writes.items.map((i) => i.service.name)).toEqual(["api"]);
    expect(writes.rejected[0]).toMatchObject({ name: "db-svc" });
    expect(text).toContain(
      'not written: db-svc: image "postgres:${PG_VERSION:-16}" uses Compose variables',
    );
    expect(manifest("api")).not.toHaveProperty("dependsOn");
    expect(text).toContain("dependsOn not written, not in this import: db");
  });

  it("does not use a health path TDK rejects", () => {
    const { manifest, text } = plan(
      [
        "services:",
        "  api:",
        "    image: example/api:1",
        "    ports: ['4000:4000']",
        "    healthcheck:",
        "      test: ['CMD', 'curl', '-f', 'http://localhost:4000/health_check']",
      ].join("\n"),
    );
    expect(manifest("api").healthCheckPath).toBe("/");
    expect(text).toContain('health path "/health_check" has characters TDK does not accept');
  });

  it("reads scheme-less host:port/path and localhost/path healthchecks and notes when no path can be read", () => {
    const { manifest, text } = plan(
      [
        "services:",
        "  web:",
        "    image: nginx:1",
        "    ports: ['8080:80']",
        "    healthcheck:",
        "      test: ['CMD', 'curl', '-f', 'localhost:80/health']",
        "  api:",
        "    image: example/api:1",
        "    ports: ['4001:4001']",
        "    healthcheck:",
        "      test: ['CMD', 'curl', '-f', 'localhost/ready']",
        "  bare:",
        "    image: example/bare:1",
        "    ports: ['4002:4002']",
        "    healthcheck:",
        "      test: ['CMD', 'curl', '-f', 'localhost:4002']",
      ].join("\n"),
    );
    expect(manifest("web").healthCheckPath).toBe("/health");
    expect(manifest("api").healthCheckPath).toBe("/ready");
    expect(manifest("bare").healthCheckPath).toBe("/");
    expect(text).toContain("    health:    /health\n");
    expect(text).toContain("    health:    /ready\n");
    expect(text).toContain("    health:    / (assumed)\n");
    expect(text).toContain(
      "health path / is assumed: no HTTP health path could be read from Compose",
    );
    expect(text).not.toContain("Compose has no HTTP healthcheck URL");
  });

  it("names every Compose key that is not translated", () => {
    const { text } = plan(
      [
        "services:",
        "  api:",
        "    image: example/api:1",
        "    command: npm run start:prod",
        "    env_file: .env.api",
        "    volumes: ['./data:/data']",
      ].join("\n"),
    );
    expect(text).toContain('service "api" keys not translated: command, env_file, volumes');
    expect(text).not.toContain("command:   ");
  });

  it("does not import a service whose build context is outside the directory", () => {
    const { p, text } = plan(
      "services:\n  api:\n    build: ../shared\n    command: node app.js\n  web:\n    image: nginx:1.27\n",
    );
    expect(p.services.map((s) => s.name)).toEqual(["web"]);
    expect(text).toContain(
      'build context "../shared" is outside the imported directory; not imported',
    );
    expect(existsSync(join(root, "services", "shop", "api"))).toBe(false);
  });

  it("imports a build context whose directory name starts with two dots while rejecting .. and ../shared", () => {
    tree({ "..cache/Dockerfile": "FROM busybox\n" });
    const { p, manifest, text } = plan(
      [
        "services:",
        "  api:",
        "    build: ./..cache",
        "    ports: ['3000:3000']",
        "  outside:",
        "    build: ../shared",
        "  parent:",
        "    build: ..",
      ].join("\n"),
    );
    expect(p.services.map((s) => s.name)).toEqual(["api"]);
    expect(p.services[0]).toMatchObject({
      name: "api",
      dir: "..cache",
      dockerfile: "Dockerfile",
    });
    expect(manifest("api")).toMatchObject({
      buildContext: "../../../..cache",
      dockerfile: "Dockerfile",
    });
    expect(text).toContain(
      'service "outside" build context "../shared" is outside the imported directory; not imported',
    );
    expect(text).toContain(
      'service "parent" build context ".." is outside the imported directory; not imported',
    );
  });
});

describe("health path for non-HTTP services", () => {
  const compose = [
    "services:",
    "  api:",
    "    build:",
    "      context: ./api",
    "    ports: ['4000:4000']",
    "    healthcheck:",
    "      test: ['CMD-SHELL', 'curl -f http://localhost:4000/health || exit 1']",
    "  db:",
    "    image: postgres:16",
    "    ports: ['5432:5432']",
    "",
  ].join("\n");

  it("omits healthCheckPath for a public infrastructure image and keeps it for a web service", () => {
    tree({ "docker-compose.yml": compose, "api/Dockerfile": "FROM node:22\nEXPOSE 4000\n" });
    const plan = buildPlan(root);
    applyWrites(planWrites(plan, false));
    const api = JSON.parse(readFileSync(serviceJson("api"), "utf8"));
    const db = JSON.parse(readFileSync(serviceJson("db-svc"), "utf8"));
    expect(api.healthCheckPath).toBe("/health");
    expect(db).not.toHaveProperty("healthCheckPath");
  });
});

describe("service names that normalise to the same value", () => {
  it("keeps a service named db-svc separate from one named db", () => {
    tree({
      "docker-compose.yml": [
        "services:",
        "  db:",
        "    image: postgres:16",
        "  db-svc:",
        "    image: redis:7",
        "  api:",
        "    image: example/api:1",
        "    depends_on: [db, db-svc]",
        "",
      ].join("\n"),
    });
    const plan = buildPlan(root);
    const names = plan.services.map((s) => s.name).sort();
    expect(names).toEqual(["api", "db-svc", "db-svc-2"]);
    const api = plan.services.find((s) => s.name === "api");
    expect(api?.dependsOn.sort()).toEqual(["db-svc", "db-svc-2"]);
  });

  it("reports renamed services in the plan while leaving matching names unnoted", () => {
    tree({
      "docker-compose.yml": [
        "services:",
        "  My_API:",
        "    image: example/api:1",
        "    ports: ['3000:3000']",
        "  web:",
        "    image: nginx:1",
        "    depends_on: [My_API]",
        "",
      ].join("\n"),
    });
    const plan = buildPlan(root);
    const writes = planWrites(plan, false);
    const text = formatPlan(plan, writes);
    const myApi = writes.items.find((i) => i.service.name === "my-api");
    const web = writes.items.find((i) => i.service.name === "web");
    expect(myApi?.notes).toContain(
      'renamed from "My_API" (Compose names must be lowercase kebab-case)',
    );
    expect(web?.notes.some((n) => n.startsWith("renamed from"))).toBe(false);
    expect(text).toContain(
      'note:      renamed from "My_API" (Compose names must be lowercase kebab-case)',
    );
  });
});
