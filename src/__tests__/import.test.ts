import { execFileSync } from "node:child_process";
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
    expect(plan.services.map((s) => s.name).sort()).toEqual(["api", "db"]);
    expect(plan.services.find((s) => s.name === "api")).toMatchObject({
      dir: "api",
      dockerfile: "Dockerfile",
      port: 4000,
      healthCheckPath: "/health",
      dependsOn: ["db"],
    });
    expect(plan.services.map((s) => s.name)).not.toContain("ignored");
  });

  it("prints a plan without writing and writes manifests plus project config only when applied", () => {
    tree({ "docker-compose.yml": compose });
    const plan = buildPlan(root);
    const writes = planWrites(plan, false);
    expect(formatPlan(plan, writes)).toContain("depends:   db");
    expect(formatPlan(plan, writes)).toContain(".flisk/project.json  [create Flisk project]");
    expect(existsSync(join(root, "services"))).toBe(false);
    expect(existsSync(join(root, ".flisk"))).toBe(false);

    applyWrites(writes);
    const api = JSON.parse(readFileSync(serviceJson("api"), "utf8"));
    const db = JSON.parse(readFileSync(serviceJson("db"), "utf8"));
    expect(api).toMatchObject({
      stack: "shop",
      appType: "bring-your-own",
      port: 4000,
      healthCheckPath: "/health",
      dependsOn: [{ name: "db", condition: "service_started" }],
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
      JSON.parse(readFileSync(join(root, ".flisk", "project.json"), "utf8")).phases.pre_alpha
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

describe("Compose values Flisk cannot take as they are", () => {
  const plan = (yaml: string) => {
    tree({ "docker-compose.yml": yaml });
    const p = buildPlan(root);
    const writes = planWrites(p, false);
    const manifest = (name: string) =>
      writes.items.find((i) => i.service.name === name)?.manifest as Record<string, unknown>;
    return { p, writes, manifest, text: formatPlan(p, writes) };
  };

  it("routes an HTTP service on 8080 and keeps its container port", () => {
    const { manifest, text } = plan(
      "services:\n  web:\n    image: example/web:1\n    ports: ['80:8080']\n",
    );
    expect(manifest("web")).toMatchObject({
      appType: "bring-your-own",
      port: 8080,
      healthCheckPath: "/",
    });
    expect(manifest("web")).not.toHaveProperty("exposeViaProxy");
    expect(text).toContain("proxy:     routed through Traefik");
    expect(text).toContain("health:    / (assumed)");
    expect(text).not.toContain("must listen on $PORT");
  });

  it("keeps a privileged Compose port: it is the port inside the container", () => {
    const { manifest, text } = plan(
      "services:\n  web:\n    image: nginx:1.27\n    ports: ['8080:80']\n",
    );
    expect(manifest("web").port).toBe(80);
    expect(text).not.toContain("must listen on $PORT");
  });

  it("keeps two services on one container port: each has its own container", () => {
    const { manifest } = plan(
      "services:\n  db:\n    image: postgres:16\n    ports: ['5432:5432']\n  analytics-db:\n    image: postgres:16\n    ports: ['5433:5432']\n",
    );
    expect(manifest("db").port).toBe(5432);
    expect(manifest("analytics-db").port).toBe(5432);
  });

  it("assigns a placeholder port and keeps the service private when Compose names no single port", () => {
    const { manifest, text } = plan(
      "services:\n  web:\n    image: example/web:1\n    ports: ['8080:80', '8443:443']\n",
    );
    expect(manifest("web").port).toBe(4000);
    expect(manifest("web").exposeViaProxy).toBe(false);
    expect(text).toContain("no single HTTP container port could be identified");
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
      'note:      image "example/api:dev" is not written: with build and image, Flisk builds from Dockerfile and does not pull the tag',
    );
  });

  it("writes an image with ${NAME} and ${NAME:-default} variables as it is", () => {
    const { writes, manifest } = plan(
      [
        "services:",
        "  db:",
        "    image: postgres:${POSTGRES_VERSION:-18}-alpine",
        "  api:",
        "    image: ghcr.io/x/y:${VERSION}",
        "  web:",
        "    image: nginx:${NGINX_TAG-1.27}",
        "    ports: ['${CODECOV_PORT-8080}:8080', '9000:9000']",
      ].join("\n"),
    );
    expect(writes.rejected).toEqual([]);
    expect(manifest("web").image).toBe("nginx:${NGINX_TAG-1.27}");
    expect(manifest("web").extraPorts).toContainEqual({
      port: 8080,
      publish: "${CODECOV_PORT-8080}",
    });
    expect(manifest("db").image).toBe("postgres:${POSTGRES_VERSION:-18}-alpine");
    expect(manifest("api").image).toBe("ghcr.io/x/y:${VERSION}");
  });

  it("does not write an image with other variable forms or characters, and drops dependencies on it", () => {
    const { writes, manifest, text } = plan(
      [
        "services:",
        "  api:",
        "    image: example/api:1",
        "    ports: ['4000:4000']",
        "    depends_on: [db, cache, web]",
        "  db:",
        "    image: postgres:$PG_VERSION",
        "  cache:",
        "    image: 'redis:${TAG:?set \"TAG\"}'",
        "  web:",
        '    image: "nginx:1\\n  privileged: true"',
      ].join("\n"),
    );
    expect(writes.items.map((i) => i.service.name)).toEqual(["api"]);
    expect(writes.rejected.map((r) => r.name).sort()).toEqual(["cache", "db", "web"]);
    expect(text).toContain(
      'not written: db: image "postgres:$PG_VERSION" has characters Flisk does not accept (Compose variables may only be ${NAME}, ${NAME:-default} or ${NAME-default})',
    );
    expect(manifest("api")).not.toHaveProperty("dependsOn");
    expect(text).toContain("dependsOn not written, not in this import: cache, db, web");
  });

  it("does not use a health path Flisk rejects", () => {
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
    expect(text).toContain('health path "/health_check" has characters Flisk does not accept');
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
        "    pull_policy: always",
        "    volumes: ['./data:/data']",
      ].join("\n"),
    );
    expect(text).toContain('service "api" keys not translated: pull_policy');
    expect(text).not.toContain("pull_policy, volumes");
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
    const db = JSON.parse(readFileSync(serviceJson("db"), "utf8"));
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
    expect(names).toEqual(["api", "db", "db-svc"]);
    const api = plan.services.find((s) => s.name === "api");
    expect(api?.dependsOn.sort()).toEqual(["db", "db-svc"]);
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

describe("environment from Compose", () => {
  const compose = [
    "services:",
    "  api:",
    "    image: example/api:1",
    "    ports: ['3000:3000']",
    "    environment:",
    "      DATABASE_URL: postgres://app:example@db:5432/app",
    "      API_TOKEN: ${API_TOKEN}",
    "      lower_case: x",
    "  db:",
    "    image: postgres:16",
    "    environment:",
    "      - POSTGRES_PASSWORD=example",
    "",
  ].join("\n");

  it("writes names as secrets and literal values to the gitignored project .env", () => {
    tree({ "docker-compose.yml": compose, ".env": "API_TOKEN=keep-me\n" });
    const writes = planWrites(buildPlan(root), false);
    applyWrites(writes);
    const api = JSON.parse(readFileSync(serviceJson("api"), "utf8"));
    const db = JSON.parse(readFileSync(serviceJson("db"), "utf8"));
    // A pure ${API_TOKEN} holds no secret itself: it is committed and read from .env at start.
    expect(api.env).toEqual({ API_TOKEN: "${API_TOKEN}" });
    expect(api.secrets).toEqual({ required: ["DATABASE_URL"] });
    expect(db.secrets).toEqual({ required: ["POSTGRES_PASSWORD"] });
    expect(readFileSync(serviceJson("api"), "utf8")).not.toContain("postgres://");

    const env = readFileSync(join(root, ".env"), "utf8");
    expect(env).toContain("API_TOKEN=keep-me\n");
    expect(env).not.toContain("${API_TOKEN}");
    expect(env).toContain("DATABASE_URL=postgres://app:example@db:5432/app\n");
    expect(env).toContain("POSTGRES_PASSWORD=example\n");
    expect(readFileSync(join(root, ".gitignore"), "utf8").split("\n")).toContain(".env");

    const api_item = writes.items.find((i) => i.service.name === "api");
    expect(api_item?.notes.join("\n")).toContain(
      "environment names not written (Flisk accepts A-Z, 0-9 and _): lower_case",
    );
  });

  it("names a value it could not copy", () => {
    tree({ "docker-compose.yml": compose });
    const writes = planWrites(buildPlan(root), false);
    const api = writes.items.find((i) => i.service.name === "api");
    expect(api?.notes).toContain("env reads API_TOKEN from the project .env; add them there");
    expect(writes.env.add).not.toHaveProperty("API_TOKEN");
  });

  it("does not touch .env or .gitignore on a dry plan", () => {
    tree({ "docker-compose.yml": compose });
    planWrites(buildPlan(root), false);
    expect(existsSync(join(root, ".env"))).toBe(false);
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
  });
});

describe("Compose runtime keys (capabilities, ports, network_mode, volumes, restart)", () => {
  // Shaped like a real self-hosted stack (a proxy, an app with a VPN client and a sidecar, a hardened helper, a database).
  const compose = [
    "services:",
    "  caddy:",
    "    image: caddy:2",
    "    restart: unless-stopped",
    "    ports: ['80:80', '443:443', '443:443/udp']",
    "    volumes:",
    "      - ./deploy/Caddyfile:/etc/caddy/Caddyfile:ro",
    "      - ./web:/srv/web:ro",
    "      - caddy-data:/data",
    "  app:",
    "    image: example/app:1",
    "    cap_add: [NET_ADMIN]",
    "    init: true",
    "    volumes: ['app-data:/data']",
    "    ports: ['3010:3010', '9100']",
    "  helper:",
    "    image: example/helper:1",
    "    network_mode: 'service:app'",
    "  companion:",
    "    image: example/companion:1",
    "    shm_size: 256mb",
    "    user: '10001:10001'",
    "    cap_drop: [ALL]",
    "    read_only: true",
    "    security_opt: ['no-new-privileges:true']",
    "    volumes: ['companion-cache:/var/tmp/cache:rw']",
    "  db:",
    "    image: postgres:14",
    "    volumes: ['postgres-data:/var/lib/postgresql/data']",
  ].join("\n");

  const plan = () => {
    tree({ "docker-compose.yml": compose, "deploy/Caddyfile": "", "web/index.html": "" });
    const p = buildPlan(root);
    const writes = planWrites(p, false);
    const manifest = (name: string) =>
      writes.items.find((i) => i.service.name === name)?.manifest as Record<string, unknown>;
    return { manifest, text: formatPlan(p, writes) };
  };

  it("carries every runtime key over, with nothing left untranslated", () => {
    const { text } = plan();
    expect(text).not.toContain("keys not translated");
    expect(text).not.toContain("is not translated");
  });

  it("publishes a proxy's 80 and 443 as extraPorts and keeps its restart policy", () => {
    const { manifest, text } = plan();
    expect(manifest("caddy")).toMatchObject({
      restart: "unless-stopped",
      exposeViaProxy: false,
      extraPorts: [
        { port: 80, bind: "0.0.0.0" },
        { port: 443, bind: "0.0.0.0" },
        { port: 443, bind: "0.0.0.0", protocol: "udp" },
      ],
    });
    expect(text).toContain(
      "published on every interface, as in Compose: 80->80/tcp, 443->443/tcp, 443->443/udp",
    );
  });

  // Compose publishes on every interface unless the mapping names an address; a migration must not change who can connect.
  it.each([
    ["'8080:7000'", { port: 7000, hostPort: 8080, bind: "0.0.0.0" }],
    ["'0.0.0.0:80:7000'", { port: 7000, hostPort: 80, bind: "0.0.0.0" }],
    ["'127.0.0.1:8080:7000'", { port: 7000, hostPort: 8080 }],
    ["'7000'", { port: 7000 }],
    ["'192.168.1.10:8080:7000'", { port: 7000, publish: "192.168.1.10:8080" }],
    ['"${APP_HTTP_BIND:-80}:7000"', { port: 7000, publish: "${APP_HTTP_BIND:-80}" }],
    ['"127.0.0.1:${APP_PORT:-8080}:7000"', { port: 7000, publish: "127.0.0.1:${APP_PORT:-8080}" }],
    ["{ target: 7000, published: 8080 }", { port: 7000, hostPort: 8080, bind: "0.0.0.0" }],
    ["{ target: 7000, published: '8080', host_ip: 127.0.0.1 }", { port: 7000, hostPort: 8080 }],
  ])("keeps the host address of %s", (spec, expected) => {
    tree({
      "docker-compose.yml": `services:\n  proxy:\n    image: caddy:2\n    ports: [${spec}, '9998:9998', '9999:9999']\n`,
    });
    const writes = planWrites(buildPlan(root), false);
    const proxy = writes.items.find((i) => i.service.name === "proxy")?.manifest as Record<
      string,
      unknown
    >;
    expect((proxy.extraPorts as unknown[])[0]).toEqual(expected);
  });

  it("does not write a host side Flisk cannot publish", () => {
    tree({
      "docker-compose.yml":
        "services:\n  proxy:\n    image: caddy:2\n    ports: ['${PORT}:7000', '9998:9998', '9999:9999']\n",
    });
    const writes = planWrites(buildPlan(root), false);
    const proxy = writes.items.find((i) => i.service.name === "proxy")?.manifest as Record<
      string,
      unknown
    >;
    expect((proxy.extraPorts as unknown[])[0]).toEqual({ port: 7000 });
  });

  it("rewrites bind mounts relative to the service directory and keeps named volumes", () => {
    const { manifest } = plan();
    expect(manifest("caddy").volumes).toEqual([
      { source: "../../../deploy/Caddyfile", target: "/etc/caddy/Caddyfile", readOnly: true },
      { source: "../../../web", target: "/srv/web", readOnly: true },
      { source: "caddy-data", target: "/data", name: "shop_caddy-data" },
    ]);
    expect(manifest("db").volumes).toEqual([
      { source: "postgres-data", target: "/var/lib/postgresql/data", name: "shop_postgres-data" },
    ]);
  });

  it("routes the app's HTTP port and publishes its second listener", () => {
    const { manifest } = plan();
    expect(manifest("app")).toMatchObject({
      port: 3010,
      container: { capAdd: ["NET_ADMIN"], init: true },
      // The routed 3010 stays published as in Compose, so plain `docker compose` (and the export) still reach it.
      extraPorts: [{ port: 3010, bind: "0.0.0.0" }, { port: 9100 }],
      volumes: [{ source: "app-data", target: "/data" }],
    });
  });

  it("makes a network_mode service a sidecar of its host", () => {
    const { manifest } = plan();
    expect(manifest("helper").sidecarOf).toBe("app");
    expect(manifest("helper")).not.toHaveProperty("extraPorts");
  });

  it("keeps a hardened helper's container options", () => {
    const { manifest } = plan();
    expect(manifest("companion").container).toEqual({
      capDrop: ["ALL"],
      readOnly: true,
      user: "10001:10001",
      securityOpt: ["no-new-privileges:true"],
      shmSize: "256mb",
    });
  });

  it("names a value it cannot carry over instead of dropping the whole key silently", () => {
    tree({
      "docker-compose.yml": [
        "services:",
        "  api:",
        "    image: example/api:1",
        "    network_mode: host",
        "    cap_add: [NET_ADMIN, 'bad cap']",
        "    restart: sometimes",
        "    volumes: ['/var/run/docker.sock:/var/run/docker.sock', '/scratch', '../outside:/x', './ok:/ok']",
        "  side:",
        "    image: example/side:1",
        "    network_mode: 'service:missing'",
      ].join("\n"),
    });
    const p = buildPlan(root);
    const writes = planWrites(p, false);
    const text = formatPlan(p, writes);
    const api = writes.items.find((i) => i.service.name === "api")?.manifest as Record<
      string,
      unknown
    >;
    expect(text).toContain('network_mode "host" is not translated');
    expect(text).toContain('cap_add ["NET_ADMIN","bad cap"] has values Flisk does not accept');
    expect(text).toContain('restart "sometimes" is not a policy Flisk accepts');
    expect(text).toContain('volume "/var/run/docker.sock:/var/run/docker.sock" is not translated');
    expect(text).toContain('volume "/scratch" is not translated');
    expect(text).toContain('volume "../outside:/x" is not translated');
    expect(text).toContain('network_mode not written: "missing" is not in this import');
    expect(api.container).toEqual({ capAdd: ["NET_ADMIN"] });
    expect(api.volumes).toEqual([{ source: "../../../ok", target: "/ok" }]);
    expect(api).not.toHaveProperty("restart");
  });
});

describe("environment values that cannot be secrets go into service.json env", () => {
  const compose = [
    "services:",
    "  app:",
    "    image: example/app:1",
    "    ports: ['3010:3010']",
    "    environment:",
    "      HT_INVIDIOUS: http://invidious:3000",
    "      PROXY: socks5://tubehaus-vpn:1080",
    "      CACHE: redis:6379",
    "      RETRIES: 3",
    "      ENABLED: 'true'",
    "      PUBLIC_URL: ${APP_URL}",
    "      PORT_HINT: ${APP_PORT:-8080}",
    "      DB_URL: postgres://user:hunter2@invidious-db/app",
    "      API_KEY: 12345",
    "      EXTERNAL: https://example.com/",
    "      MODE: production",
    "      SESSION_TTL: ${SESSION_TTL}",
    "  invidious:",
    "    image: example/invidious:1",
    "  invidious-db:",
    "    image: postgres:16",
    "  tubehaus-vpn:",
    "    image: example/vpn:1",
    "  redis:",
    "    image: redis:7",
  ].join("\n");

  it("commits literals and ${VAR} references, and keeps credential names and values that hold one secret", () => {
    tree({ "docker-compose.yml": compose });
    const writes = planWrites(buildPlan(root), false);
    applyWrites(writes);
    const app = JSON.parse(readFileSync(serviceJson("app"), "utf8"));
    expect(app.env).toEqual({
      CACHE: "redis:6379",
      ENABLED: "true",
      EXTERNAL: "https://example.com/",
      HT_INVIDIOUS: "http://invidious:3000",
      MODE: "production",
      PORT_HINT: "${APP_PORT:-8080}",
      PROXY: "socks5://tubehaus-vpn:1080",
      PUBLIC_URL: "${APP_URL}",
      RETRIES: "3",
      SESSION_TTL: "${SESSION_TTL}",
    });
    // A credential name and a URL with a password stay out of service.json.
    expect(app.secrets).toEqual({ required: ["API_KEY", "DB_URL"] });
    expect(readFileSync(serviceJson("app"), "utf8")).not.toContain("hunter2");
    const env = readFileSync(join(root, ".env"), "utf8");
    expect(env).toContain("DB_URL=postgres://user:hunter2@invidious-db/app\n");
    expect(env).not.toContain("HT_INVIDIOUS=");
  });

  it("names the variables a committed ${VAR} reference needs, but not one with a default", () => {
    tree({ "docker-compose.yml": compose });
    const writes = planWrites(buildPlan(root), false);
    const notes = writes.items.find((i) => i.service.name === "app")?.notes.join("\n");
    expect(notes).toContain("env reads APP_URL, SESSION_TTL from the project .env; add them there");
    expect(notes).not.toContain("APP_PORT");
  });
});

describe("Compose command, healthcheck, ports and restart", () => {
  const compose = [
    "services:",
    "  migrate:",
    "    image: example/app:1",
    "    command: bundle exec rails db:prepare",
    "    restart: 'no'",
    "  worker:",
    "    image: example/app:1",
    "    command: ['bundle', 'exec', 'sidekiq']",
    "    restart: on-failure:5",
    "  db:",
    "    image: postgres:16",
    "    ports: ['127.0.0.1:5432:5432']",
    "    healthcheck:",
    "      test: pg_isready -U app",
    "      interval: 2s",
    "      timeout: 5s",
    "      retries: 30",
  ].join("\n");

  function written() {
    tree({ "docker-compose.yaml": compose });
    const plan = buildPlan(root);
    const writes = planWrites(plan, false);
    applyWrites(writes);
    return (name: string) => JSON.parse(readFileSync(serviceJson(name), "utf8"));
  }

  it("reads docker-compose.yaml", () => {
    expect(buildPlan((tree({ "docker-compose.yaml": compose }), root)).services).toHaveLength(3);
  });

  it("wraps an image in a Dockerfile that carries the Compose command", () => {
    const manifest = written();
    expect(manifest("migrate")).toMatchObject({ buildContext: ".", dockerfile: "Dockerfile" });
    expect(manifest("migrate")).not.toHaveProperty("image");
    expect(readFileSync(join(dirname(serviceJson("migrate")), "Dockerfile"), "utf8")).toContain(
      'FROM example/app:1\nCMD ["bundle","exec","rails","db:prepare"]\n',
    );
    expect(readFileSync(join(dirname(serviceJson("worker")), "Dockerfile"), "utf8")).toContain(
      'CMD ["bundle","exec","sidekiq"]',
    );
  });

  it("keeps on-failure with its retry limit", () => {
    expect(written()("worker").restart).toBe("on-failure:5");
  });

  it("keeps a published database port and writes its healthcheck as a probe command", () => {
    const db = written()("db");
    expect(db.extraPorts).toEqual([{ port: 5432 }]);
    expect(db.healthCheck).toEqual({
      command: ["sh", "-c", "pg_isready -U app"],
      interval: 2,
      timeout: 5,
      retries: 30,
    });
  });

  it("writes a Compose entrypoint as ENTRYPOINT and ignores networks and expose", () => {
    tree({
      "docker-compose.yml":
        "services:\n  guard:\n    image: mongo:7\n    entrypoint: ['sh','-c','echo ok']\n    networks: [a]\n    expose: ['27017']\n",
    });
    const plan = buildPlan(root);
    applyWrites(planWrites(plan, false));
    expect(readFileSync(join(dirname(serviceJson("guard")), "Dockerfile"), "utf8")).toContain(
      'FROM mongo:7\nENTRYPOINT ["sh","-c","echo ok"]\n',
    );
    expect(formatPlan(plan, planWrites(plan, true))).not.toContain("keys not translated");
  });

  it("keeps Compose models as service.json models", () => {
    tree({
      "docker-compose.yml":
        "services:\n  web:\n    image: app:1\n    models: [llm]\nmodels:\n  llm:\n    model: ai/smollm2\n",
    });
    applyWrites(planWrites(buildPlan(root), false));
    expect(JSON.parse(readFileSync(serviceJson("web"), "utf8")).models).toEqual([
      { name: "llm", model: "ai/smollm2" },
    ]);
  });

  it("names each volume as docker compose created it, so the install's data is reused", () => {
    tree({
      "docker-compose.yml": [
        "name: My-App",
        "services:",
        "  db:",
        "    image: postgres:16",
        "    volumes: [pg:/var/lib/postgresql/data, mysql:/m, shared:/s, vars:/v]",
        "volumes:",
        "  pg:",
        "  mysql:",
        "    name: lychee_prod_mysql",
        "  shared:",
        "    external: true",
        "  vars:",
        "    name: ${PREFIX}_vars",
      ].join("\n"),
    });
    applyWrites(planWrites(buildPlan(root), false));
    expect(JSON.parse(readFileSync(serviceJson("db"), "utf8")).volumes).toEqual([
      { source: "pg", target: "/var/lib/postgresql/data", name: "my-app_pg" },
      { source: "mysql", target: "/m", name: "lychee_prod_mysql" },
      { source: "shared", target: "/s", name: "shared" },
      { source: "vars", target: "/v" },
    ]);
  });

  it("keeps profiles, env_file, tmpfs and deploy limits", () => {
    tree({
      "docker-compose.yml": [
        "services:",
        "  api:",
        "    image: ghcr.io/lycheeorg/lychee:latest",
        "    profiles: [nsfw]",
        "    env_file:",
        "      - path: ./.env",
        "    tmpfs:",
        "      - /tmp:noexec,nosuid,nodev,size=100m",
        "    deploy:",
        "      resources:",
        "        limits: { cpus: '2', memory: 2G }",
        "        reservations: { cpus: '0.5' }",
      ].join("\n"),
    });
    const plan = buildPlan(root);
    const writes = planWrites(plan, false);
    applyWrites(writes);
    const api = JSON.parse(readFileSync(serviceJson("api"), "utf8"));
    expect(api.profiles).toEqual(["nsfw"]);
    expect(api.envFile).toEqual(["../../../.env"]);
    expect(api.container).toEqual({
      tmpfs: ["/tmp:noexec,nosuid,nodev,size=100m"],
      cpus: 2,
      memory: "2G",
    });
    expect(formatPlan(plan, writes)).toContain("deploy.resources.reservations is not carried over");
  });
});

describe("Compose stop_grace_period, network aliases, extra_hosts, ulimits and container_name", () => {
  function imported(compose: string) {
    tree({ "docker-compose.yml": compose });
    const plan = buildPlan(root);
    const writes = planWrites(plan, false);
    applyWrites(writes);
    return {
      text: formatPlan(plan, writes),
      writes,
      manifest: (name: string) => JSON.parse(readFileSync(serviceJson(name), "utf8")),
    };
  }

  it("keeps a pl_mail worker's alias, stop_grace_period and variable image", () => {
    const { manifest, text } = imported(
      [
        "services:",
        "  worker:",
        "    image: postgres:${POSTGRES_VERSION:-18}-alpine",
        "    stop_grace_period: 30s",
        "    networks:",
        "      default:",
        "        aliases: [mercure]",
      ].join("\n"),
    );
    expect(manifest("worker")).toMatchObject({
      image: "postgres:${POSTGRES_VERSION:-18}-alpine",
      container: { stopGracePeriod: "30s", networkAliases: ["mercure"] },
    });
    expect(text).not.toContain("keys not translated");
  });

  it("reads aliases from every network and accepts 1m30s and 500ms", () => {
    const { manifest } = imported(
      [
        "services:",
        "  api:",
        "    image: app:1",
        "    stop_grace_period: 1m30s",
        "    networks:",
        "      front: { aliases: [api.local, api_v1] }",
        "      back:",
        "        aliases: [api_v1, internal-api]",
        "      other:",
        "  web:",
        "    image: app:1",
        "    stop_grace_period: 500ms",
        "    networks: [front]",
        "networks: { front: {}, back: {}, other: {} }",
      ].join("\n"),
    );
    expect(manifest("api").container).toEqual({
      stopGracePeriod: "1m30s",
      networkAliases: ["api.local", "api_v1", "internal-api"],
    });
    expect(manifest("web").container).toEqual({ stopGracePeriod: "500ms" });
  });

  it("keeps a renamed Lychee service's Compose name as a network alias", () => {
    const { manifest, writes, text } = imported(
      [
        "services:",
        "  lychee_api:",
        "    image: ghcr.io/lycheeorg/lychee:latest",
        "    ports: ['8000:8000']",
        "    environment:",
        "      DB_HOST: lychee_db:3306",
        "    depends_on: [lychee_db]",
        "  lychee_db:",
        "    image: mariadb:11",
        "    networks:",
        "      default: { aliases: [db] }",
        "  web:",
        "    image: nginx:1",
        "    environment:",
        "      API_URL: http://lychee_api:8000",
        "    depends_on: [lychee_api]",
      ].join("\n"),
    );
    expect(manifest("lychee-api").container).toEqual({ networkAliases: ["lychee_api"] });
    expect(manifest("lychee-db").container).toEqual({ networkAliases: ["db", "lychee_db"] });
    expect(manifest("lychee-api").env).toEqual({ DB_HOST: "lychee_db:3306" });
    expect(manifest("web").env).toEqual({ API_URL: "http://lychee_api:8000" });
    expect(manifest("web")).not.toHaveProperty("container");
    expect(writes.items.find((i) => i.service.name === "lychee-api")?.notes).toContain(
      'network alias "lychee_api" keeps the Compose name, so other services that call it by that name still reach it',
    );
    expect(text).toContain('renamed from "lychee_db"');
  });

  it("gives a renamed sidecar no aliases, since it shares another service's network", () => {
    const { manifest, text } = imported(
      [
        "services:",
        "  vpn:",
        "    image: qmcgaw/gluetun:v3",
        "  dl_client:",
        "    image: example/dl:1",
        "    network_mode: service:vpn",
        "    networks: { default: { aliases: [dl] } }",
      ].join("\n"),
    );
    expect(manifest("dl-client")).not.toHaveProperty("container");
    expect(manifest("dl-client").sidecarOf).toBe("vpn");
    expect(text).toContain(
      `network aliases not written (dl, dl_client): a sidecar shares "vpn"'s network`,
    );
  });

  it("keeps EDDI's extra_hosts and open-mercato's ulimits", () => {
    const { manifest } = imported(
      [
        "services:",
        "  eddi:",
        "    image: labsai/eddi:latest",
        '    extra_hosts: ["host.docker.internal:host-gateway"]',
        "    ulimits:",
        "      nofile: { soft: 65536, hard: 65536 }",
        "      nproc: 65535",
        "  mercato:",
        "    image: open-mercato/app:1",
        "    extra_hosts:",
        "      db.internal: 10.0.0.5",
        "      v6host: '::1'",
        "  other:",
        "    image: app:1",
        "    extra_hosts: ['api=192.168.1.2', 'myhostv6:::1', 'api:192.168.1.2']",
      ].join("\n"),
    );
    expect(manifest("eddi").container).toEqual({
      extraHosts: ["host.docker.internal:host-gateway"],
      ulimits: { nofile: { soft: 65536, hard: 65536 }, nproc: 65535 },
    });
    expect(manifest("mercato").container).toEqual({
      extraHosts: ["db.internal:10.0.0.5", "v6host:::1"],
    });
    expect(manifest("other").container).toEqual({
      extraHosts: ["api:192.168.1.2", "myhostv6:::1"],
    });
  });

  it("names values it cannot carry over and writes none of them", () => {
    const { manifest, text } = imported(
      [
        "services:",
        "  api:",
        "    image: app:1",
        "    stop_grace_period: soon",
        "    networks:",
        '      default: { aliases: ["bad alias", "ok"] }',
        '    extra_hosts: ["evil\\nkey: 1:1.2.3.4", "name:not-an-ip", "host.docker.internal:host-gateway"]',
        "    ulimits:",
        "      nofile: { soft: 10, hard: 5 }",
        "      NPROC: 5",
        "      core: unlimited",
        "      memlock: { soft: -1, hard: -1 }",
      ].join("\n"),
    );
    expect(manifest("api").container).toEqual({
      networkAliases: ["ok"],
      extraHosts: ["host.docker.internal:host-gateway"],
      ulimits: { memlock: { soft: -1, hard: -1 } },
    });
    expect(text).toContain('stop_grace_period "soon" is not a duration');
    expect(text).toContain('network aliases ["bad alias"] are not DNS names');
    expect(text).toContain('extra_hosts ["evil\\nkey: 1:1.2.3.4","name:not-an-ip"] are not');
    expect(text).toContain("ulimits nofile, NPROC, core are not a whole number");
  });

  it("drops container_name with a note, not as an untranslated key", () => {
    const { manifest, text } = imported(
      "services:\n  db:\n    image: postgres:16\n    container_name: lychee_db\n",
    );
    expect(manifest("db")).not.toHaveProperty("container");
    expect(text).toContain('container_name "lychee_db" is dropped: Flisk names containers itself');
    expect(text).not.toContain("keys not translated");
  });

  it("refuses an on-failure limit outside 1 to 100", () => {
    const { manifest, text } = imported(
      "services:\n  zero:\n    image: app:1\n    restart: on-failure:0\n  many:\n    image: app:1\n    restart: on-failure:101\n  max:\n    image: app:1\n    restart: on-failure:100\n",
    );
    expect(manifest("zero")).not.toHaveProperty("restart");
    expect(manifest("many")).not.toHaveProperty("restart");
    expect(manifest("max").restart).toBe("on-failure:100");
    expect(text).toContain('restart "on-failure:101" is not a policy Flisk accepts');
  });
});

describe("Compose command and entrypoint strings, split as Compose splits them", () => {
  function dockerfile(compose: string) {
    tree({ "docker-compose.yml": compose });
    const plan = buildPlan(root);
    const writes = planWrites(plan, false);
    applyWrites(writes);
    return {
      text: formatPlan(plan, writes),
      file: (name: string) => readFileSync(join(dirname(serviceJson(name)), "Dockerfile"), "utf8"),
    };
  }

  it("writes codecov's minio `command: server /export` as exec-form arguments to the image ENTRYPOINT", () => {
    const { file } = dockerfile(
      "services:\n  minio:\n    image: minio/minio:RELEASE.2020-04-15T00-39-01Z\n    command: server /export\n",
    );
    expect(file("minio")).toContain('CMD ["server","/export"]\n');
    expect(file("minio")).not.toContain("sh");
  });

  it("splits quotes and backslashes like a shell", () => {
    const { file } = dockerfile(
      [
        "services:",
        "  api:",
        "    image: app:1",
        `    entrypoint: /bin/run --name "my app" 'a b' c\\ d`,
        `    command: echo "say \\"hi\\"" ''`,
      ].join("\n"),
    );
    expect(file("api")).toContain('ENTRYPOINT ["/bin/run","--name","my app","a b","c d"]\n');
    expect(file("api")).toContain('CMD ["echo","say \\"hi\\"",""]\n');
  });

  it("keeps a list form as it is", () => {
    const { file } = dockerfile(
      "services:\n  worker:\n    image: app:1\n    command: ['sh', '-c', 'a && b']\n",
    );
    expect(file("worker")).toContain('CMD ["sh","-c","a && b"]\n');
  });

  it("falls back to sh -c for a string it cannot split, and says so", () => {
    const { file, text } = dockerfile(
      `services:\n  bad:\n    image: app:1\n    command: echo "unbalanced\n`,
    );
    expect(file("bad")).toContain('CMD ["sh","-c","echo \\"unbalanced"]\n');
    expect(text).toContain("has unbalanced quotes; it runs through sh -c");
  });
});

describe("Compose round trip: routed ports, healthchecks and env survive an export", () => {
  function imported(compose: string) {
    tree({ "docker-compose.yml": compose });
    const plan = buildPlan(root);
    const writes = planWrites(plan, false);
    applyWrites(writes);
    return {
      text: formatPlan(plan, writes),
      manifest: (name: string) => JSON.parse(readFileSync(serviceJson(name), "utf8")),
    };
  }

  it("keeps a routed port's host mapping as extraPorts, but not a bare routed port", () => {
    const { manifest } = imported(
      [
        "services:",
        "  api:",
        "    image: app:1",
        "    ports: ['${APP_PORT:-8000}:8000']",
        "  web:",
        "    image: app:1",
        "    ports: ['3000']",
        "  local:",
        "    image: app:1",
        "    ports: ['127.0.0.1:4000:4000']",
      ].join("\n"),
    );
    expect(manifest("api")).toMatchObject({
      port: 8000,
      extraPorts: [{ port: 8000, publish: "${APP_PORT:-8000}" }],
    });
    expect(manifest("web").port).toBe(3000);
    expect(manifest("web")).not.toHaveProperty("extraPorts");
    expect(manifest("local").extraPorts).toEqual([{ port: 4000 }]);
  });

  it("keeps the healthcheck command and start_period next to the HTTP path it read", () => {
    const { manifest, text } = imported(
      [
        "services:",
        "  api:",
        "    image: app:1",
        "    ports: ['8000:8000']",
        "    healthcheck:",
        "      test: ['CMD', 'curl', '-f', 'http://localhost:8000/up']",
        "      interval: 1m30s",
        "      timeout: 500ms",
        "      start_period: 2m",
      ].join("\n"),
    );
    expect(manifest("api").healthCheckPath).toBe("/up");
    expect(manifest("api").healthCheck).toEqual({
      command: ["curl", "-f", "http://localhost:8000/up"],
      interval: 90,
      timeout: 0.5,
      startPeriod: 120,
    });
    expect(text).toContain("is kept as Compose wrote it; Flisk probes with it instead of /up");
  });

  it("commits pure Compose expressions whatever their name, and literals unless they hold a credential", () => {
    const { manifest } = imported(
      [
        "services:",
        "  api:",
        "    image: app:1",
        "    environment:",
        '      DB_PASSWORD: "${DB_PASSWORD:-password}"',
        '      APP_KEY: "${APP_KEY:-}"',
        '      PORT_DASH: "${PORT-8080}"',
        '      NESTED: "${A:-${B:-file}}"',
        "      PMA_HOST: lychee_db",
        "      MODE: worker",
        "      DB_PASS: literal",
        "      DSN: mysql://root:pw@db/app",
        "      HOOK: https://hooks.example.com/x?token=abc",
        "      BLOB: AbCdEf0123456789AbCdEf0123456789xyz",
        "      NOTE: my-secret-value",
        '      MIXED: "x${A}"',
      ].join("\n"),
    );
    expect(manifest("api").env).toEqual({
      APP_KEY: "${APP_KEY:-}",
      DB_PASSWORD: "${DB_PASSWORD:-password}",
      MIXED: "x${A}",
      MODE: "worker",
      NESTED: "${A:-${B:-file}}",
      PMA_HOST: "lychee_db",
      PORT_DASH: "${PORT-8080}",
    });
    expect(manifest("api").secrets.required.sort()).toEqual([
      "BLOB",
      "DB_PASS",
      "DSN",
      "HOOK",
      "NOTE",
    ]);
  });
});

describe("a project .env that git tracks (Symfony-style committed defaults)", () => {
  const compose = [
    "services:",
    "  worker:",
    "    image: postgres:${POSTGRES_VERSION:-18}-alpine",
    "    environment:",
    "      POSTGRES_PASSWORD_FILE: /run/plmail/postgres_password",
    "      NTFY_LISTEN_HTTP: ':80'",
    "      NTFY_VISITOR_REQUEST_LIMIT_REPLENISH: 5s",
    "      NTFY_AUTH_FILE: /var/lib/ntfy/auth.db",
    "      API_TOKEN: s3cr3t",
  ].join("\n");
  const tracked = "APP_ENV=dev\n";

  function importTracked(gitignore: string) {
    tree({ "docker-compose.yml": compose, ".env": tracked, ".gitignore": gitignore });
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", ".env", ".gitignore"], { cwd: root });
    const writes = planWrites(buildPlan(root), false);
    applyWrites(writes);
    return { writes, manifest: JSON.parse(readFileSync(serviceJson("worker"), "utf8")) };
  }

  it("leaves the tracked .env and .gitignore alone and writes secrets to the ignored .env.local", () => {
    const { writes, manifest } = importTracked("/.env.local\n");
    expect(readFileSync(join(root, ".env"), "utf8")).toBe(tracked);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("/.env.local\n");
    expect(readFileSync(join(root, ".env.local"), "utf8")).toContain("API_TOKEN=s3cr3t\n");
    expect(writes.env).toMatchObject({ tracked: ".env" });
    expect(manifest.envFile).toEqual(["../../../.env.local"]);
    expect(manifest.secrets).toEqual({ required: ["API_TOKEN"] });
  });

  it("uses .flisk/.env.import, gitignored, when .env.local is not ignored", () => {
    const { manifest } = importTracked("vendor/\n");
    expect(readFileSync(join(root, ".env"), "utf8")).toBe(tracked);
    expect(readFileSync(join(root, ".flisk", ".env.import"), "utf8")).toContain(
      "API_TOKEN=s3cr3t\n",
    );
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("vendor/\n.flisk/.env.import\n");
    expect(manifest.envFile).toEqual(["../../../.flisk/.env.import"]);
  });

  it("commits pl_mail's secret-file paths and plain settings in env", () => {
    const { manifest } = importTracked("/.env.local\n");
    expect(manifest.env).toEqual({
      NTFY_AUTH_FILE: "/var/lib/ntfy/auth.db",
      NTFY_LISTEN_HTTP: ":80",
      NTFY_VISITOR_REQUEST_LIMIT_REPLENISH: "5s",
      POSTGRES_PASSWORD_FILE: "/run/plmail/postgres_password",
    });
  });
});

describe("pl_mail round trip: restart default, a turned-off healthcheck and image variables in a generated Dockerfile", () => {
  const compose = [
    "services:",
    "  database:",
    "    image: postgres:${POSTGRES_VERSION:-18}-alpine",
    "    command: postgres -c max_connections=200",
    "  worker:",
    "    image: example/worker:${TAG}",
    "    command: ['php', 'bin/console', 'messenger:consume']",
    "    restart: unless-stopped",
    "    healthcheck:",
    "      disable: true",
    "  ntfy:",
    "    image: binwiederhier/ntfy:v2",
    "    ports: ['${NTFY_PORT:-8090}:80']",
    "    healthcheck:",
    "      test: ['NONE']",
  ].join("\n");

  function imported() {
    tree({ "docker-compose.yml": compose });
    const plan = buildPlan(root);
    applyWrites(planWrites(plan, false));
    return (name: string) => JSON.parse(readFileSync(serviceJson(name), "utf8"));
  }

  it('leaves restart out for a long-running service, since Flisk runs restart "no" as a one-shot job', () => {
    tree({ "docker-compose.yml": compose });
    const plan = buildPlan(root);
    const writes = planWrites(plan, false);
    applyWrites(writes);
    const manifest = (name: string) => JSON.parse(readFileSync(serviceJson(name), "utf8"));
    expect(manifest("database")).not.toHaveProperty("restart");
    expect(manifest("worker").restart).toBe("unless-stopped");
    expect(formatPlan(plan, writes)).toContain(
      "restart not set for database, ntfy: Flisk restarts them (unless-stopped), where Compose would not restart them after a crash or a reboot",
    );
  });

  it('writes restart "no" for a job another service waits for with service_completed_successfully (EDDI, nosia)', () => {
    tree({
      "docker-compose.yml": [
        "services:",
        "  bind-guard:",
        "    image: alpine:3",
        "  db-migrate:",
        "    image: app:1",
        "    restart: 'no'",
        "  eddi:",
        "    image: labsai/eddi:6",
        "    depends_on:",
        "      bind-guard: { condition: service_completed_successfully }",
        "      db-migrate: { condition: service_completed_successfully }",
      ].join("\n"),
    });
    applyWrites(planWrites(buildPlan(root), false));
    const manifest = (name: string) => JSON.parse(readFileSync(serviceJson(name), "utf8"));
    expect(manifest("bind-guard").restart).toBe("no");
    expect(manifest("db-migrate").restart).toBe("no");
    expect(manifest("eddi")).not.toHaveProperty("restart");
  });

  it("keeps disable: true and test: [NONE] as healthCheck: false, with no health path", () => {
    const manifest = imported();
    expect(manifest("worker").healthCheck).toBe(false);
    expect(manifest("ntfy").healthCheck).toBe(false);
    expect(manifest("ntfy")).not.toHaveProperty("healthCheckPath");
    expect(manifest("ntfy").extraPorts).toEqual([{ port: 80, publish: "${NTFY_PORT:-8090}" }]);
  });

  it("declares the image's variables as ARG before FROM, with the expression's default", () => {
    imported();
    const dockerfile = (name: string) =>
      readFileSync(join(dirname(serviceJson(name)), "Dockerfile"), "utf8");
    expect(dockerfile("database")).toContain(
      'ARG POSTGRES_VERSION=18\nFROM postgres:${POSTGRES_VERSION:-18}-alpine\nCMD ["postgres","-c","max_connections=200"]\n',
    );
    expect(dockerfile("worker")).toContain("ARG TAG\nFROM example/worker:${TAG}\n");
  });
});

describe("env values that mix Compose expressions with literal text", () => {
  it("commits them unless the name or the text could be a credential", () => {
    tree({
      "docker-compose.yml": [
        "services:",
        "  php:",
        "    image: app:1",
        "    environment:",
        '      SERVER_NAME: "${SERVER_NAME:-localhost, :443}, php:80"',
        '      DATABASE_URL: "postgres://app:${DB_PASSWORD}@database:5432/app"',
        '      API_TOKEN: "tok-${SUFFIX}"',
        '      BAD: "x$Y${Z}"',
        '      MONGODB_CONNECTIONSTRING: "mongodb://${U:-app}:${P:-${ROOT:-changeme}}@mongodb:27017/eddi?authSource=eddi"',
        '      HOOK_URL: "https://x.example.com/${PATH_PART}?token=abc"',
      ].join("\n"),
    });
    applyWrites(planWrites(buildPlan(root), false));
    const php = JSON.parse(readFileSync(serviceJson("php"), "utf8"));
    expect(php.env).toEqual({
      MONGODB_CONNECTIONSTRING:
        "mongodb://${U:-app}:${P:-${ROOT:-changeme}}@mongodb:27017/eddi?authSource=eddi",
      SERVER_NAME: "${SERVER_NAME:-localhost, :443}, php:80",
    });
    // A literal user (app:) or token query parameter stays secret.
    expect(php.secrets.required.sort()).toEqual(["API_TOKEN", "BAD", "DATABASE_URL", "HOOK_URL"]);
  });
});

describe("the Compose project name, recorded for an export", () => {
  it("records the folder name as Compose computes it in a new project.json", () => {
    tree({ "docker-compose.yml": "services:\n  web:\n    image: nginx:1\n" });
    applyWrites(planWrites(buildPlan(root), false));
    const config = JSON.parse(readFileSync(join(root, ".flisk", "project.json"), "utf8"));
    expect(config.composeProjectNames).toEqual({ shop: "shop" });
  });

  it("records a top-level name in an existing project.json and keeps the rest", () => {
    tree({
      "docker-compose.yml": "name: Pl_Mail\nservices:\n  web:\n    image: nginx:1\n",
      ".flisk/project.json": '{"version":"1.0","custom":{"a":1}}\n',
    });
    const plan = buildPlan(root);
    const writes = planWrites(plan, false);
    expect(formatPlan(plan, writes)).toContain('[add composeProjectNames.shop: "pl_mail"');
    applyWrites(writes);
    expect(JSON.parse(readFileSync(join(root, ".flisk", "project.json"), "utf8"))).toEqual({
      version: "1.0",
      custom: { a: 1 },
      composeProjectNames: { shop: "pl_mail" },
    });
    expect(planWrites(buildPlan(root), false).projectConfigUpdate).toBeUndefined();
  });
});

describe("$$ and Compose variables in a command moved into a Dockerfile (EDDI)", () => {
  function dockerfile(compose: string) {
    tree({ "docker-compose.yml": compose });
    const plan = buildPlan(root);
    const writes = planWrites(plan, false);
    applyWrites(writes);
    return {
      text: formatPlan(plan, writes),
      file: (name: string) => readFileSync(join(dirname(serviceJson(name)), "Dockerfile"), "utf8"),
    };
  }

  it("turns $$ into $, so the container's shell reads the variable instead of its PID", () => {
    const { file, text } = dockerfile(
      [
        "services:",
        "  mongodb-app-user:",
        "    image: mongo:7",
        `    entrypoint: ["sh", "-c", "mongosh -u app -p \\"$$MONGO_APP_PASSWORD\\" --eval 'db.x'"]`,
        "    restart: 'no'",
        "  echo-home:",
        "    image: alpine:3",
        "    command: sh -c 'echo $$HOME'",
      ].join("\n"),
    );
    expect(file("mongodb-app-user")).toContain(
      `ENTRYPOINT ["sh","-c","mongosh -u app -p \\"$MONGO_APP_PASSWORD\\" --eval 'db.x'"]`,
    );
    expect(file("echo-home")).toContain('CMD ["sh","-c","echo $HOME"]');
    expect(text).not.toContain("uses Compose variables");
  });

  it("names a command that uses Compose variables, which a Dockerfile cannot fill from .env", () => {
    const { file, text } = dockerfile(
      [
        "services:",
        "  app:",
        "    image: alpine:3",
        "    command: echo ${GREETING:-hi}",
        "  list:",
        "    image: alpine:3",
        "    command: ['sh', '-c', 'echo ${NAME}']",
      ].join("\n"),
    );
    expect(file("app")).toContain('CMD ["sh","-c","echo ${GREETING:-hi}"]');
    expect(file("list")).toContain('CMD ["sh","-c","echo ${NAME}"]');
    expect(text).toContain(
      'service "app" command "echo ${GREETING:-hi}" uses Compose variables, which Compose filled from .env; in the generated Dockerfile it runs through sh -c',
    );
    expect(text).toContain(
      'service "list" command ["sh","-c","echo ${NAME}"] uses Compose variables',
    );
  });
});

describe("include and extends, resolved through docker compose config (wger)", () => {
  const files = {
    "docker-compose.yml": [
      "services:",
      "  web:",
      "    image: docker.io/wger/server:latest",
      "    depends_on:",
      "      db: { condition: service_healthy }",
      "      cache: { condition: service_healthy }",
      "  powersync:",
      "    depends_on:",
      "      db: { condition: service_healthy }",
      "  nginx:",
      "    image: docker.io/nginx:stable",
      "    ports: ['80:80']",
      "    volumes: ['./config/nginx.conf:/etc/nginx/conf.d/default.conf']",
      "  worker:",
      "    extends: { file: services/redis.yaml, service: cache }",
      "    command: ['redis-server', '--port', '6380']",
      "include:",
      "  - path: ./services/postgres.yaml",
      "  - path: ./services/powersync.yaml",
      "  - path: ./services/redis.yaml",
    ].join("\n"),
    "services/postgres.yaml":
      "services:\n  db:\n    image: docker.io/postgres:15-alpine\n    env_file: [../config/prod.env]\n    volumes: [postgres-data:/var/lib/postgresql/data]\nvolumes:\n  postgres-data:\n",
    "services/powersync.yaml":
      "services:\n  powersync:\n    image: docker.io/journeyapps/powersync-service:latest\n    volumes: ['./config-powersync:/config:ro']\n",
    "services/redis.yaml": "services:\n  cache:\n    image: docker.io/redis:7\n",
    "config/prod.env": "SECRET_KEY=x\n",
    "config/nginx.conf": "",
    "services/config-powersync/powersync.yaml": "",
  };
  const hasDocker = (() => {
    try {
      // The flags the importer passes; an older docker compose lacks them and the importer reads the YAML instead.
      const help = execFileSync("docker", ["compose", "config", "--help"], { encoding: "utf8" });
      return help.includes("--no-path-resolution") && help.includes("--no-env-resolution");
    } catch {
      return false;
    }
  })();

  it("falls back to the YAML reader, and says so, when docker compose is not used", () => {
    const before = process.env.FLISK_IMPORT_DOCKER;
    process.env.FLISK_IMPORT_DOCKER = "0";
    try {
      tree(files);
      const plan = buildPlan(root);
      const text = formatPlan(plan, planWrites(plan, false));
      expect(text).toContain(
        "uses include or extends, which only `docker compose config` resolves; docker compose was not available (or failed), so the file was read as YAML",
      );
      expect(text).toContain(
        "not written: powersync: Compose gives it neither `image` nor a usable `build`",
      );
    } finally {
      if (before === undefined) delete process.env.FLISK_IMPORT_DOCKER;
      else process.env.FLISK_IMPORT_DOCKER = before;
    }
  });

  it.runIf(hasDocker && process.env.FLISK_IMPORT_DOCKER !== "0")(
    "imports a service that only an included file defines, and resolves extends",
    () => {
      tree({
        "docker-compose.yml":
          "include:\n  - path: ./services/postgres.yaml\nservices:\n  web:\n    extends: { file: services/base.yaml, service: base }\n    depends_on: [db]\n",
        "services/postgres.yaml":
          "services:\n  db:\n    image: docker.io/postgres:15-alpine\n    volumes: ['./initdb:/docker-entrypoint-initdb.d:ro']\n",
        "services/base.yaml":
          "services:\n  base:\n    image: docker.io/wger/server:latest\n    stop_grace_period: 60s\n",
        "services/initdb/01.sql": "",
      });
      const plan = buildPlan(root);
      const writes = planWrites(plan, false);
      applyWrites(writes);
      const manifest = (name: string) => JSON.parse(readFileSync(serviceJson(name), "utf8"));
      expect(writes.rejected).toEqual([]);
      expect(manifest("db").volumes).toEqual([
        { source: "../../initdb", target: "/docker-entrypoint-initdb.d", readOnly: true },
      ]);
      expect(manifest("web")).toMatchObject({
        image: "docker.io/wger/server:latest",
        dependsOn: [{ name: "db", condition: "service_started" }],
        container: { stopGracePeriod: "60s" },
      });
    },
  );

  it.runIf(hasDocker && process.env.FLISK_IMPORT_DOCKER !== "0")(
    "imports included and extended services with their own paths",
    (ctx) => {
      tree(files);
      // docker compose before v2.39 refuses a root file that overrides an included service ("conflicts with imported
      // resource"), as `docker compose up` does there too; the importer then reads the YAML, so there is nothing to check.
      try {
        execFileSync(
          "docker",
          [
            "compose",
            "-f",
            join(root, "docker-compose.yml"),
            "config",
            "--no-path-resolution",
            "-q",
          ],
          { cwd: root, stdio: "ignore" },
        );
      } catch {
        ctx.skip();
      }
      const plan = buildPlan(root);
      const writes = planWrites(plan, false);
      applyWrites(writes);
      const manifest = (name: string) => JSON.parse(readFileSync(serviceJson(name), "utf8"));
      expect(writes.rejected).toEqual([]);
      expect(manifest("db")).toMatchObject({
        image: "docker.io/postgres:15-alpine",
        envFile: ["../../../config/prod.env"],
        volumes: [{ source: "postgres-data", target: "/var/lib/postgresql/data" }],
      });
      expect(manifest("cache").image).toBe("docker.io/redis:7");
      expect(manifest("powersync")).toMatchObject({
        image: "docker.io/journeyapps/powersync-service:latest",
        dependsOn: [{ name: "db", condition: "service_healthy" }],
        volumes: [{ source: "../../config-powersync", target: "/config", readOnly: true }],
      });
      expect(manifest("nginx").volumes).toEqual([
        { source: "../../../config/nginx.conf", target: "/etc/nginx/conf.d/default.conf" },
      ]);
      expect(manifest("nginx").extraPorts).toEqual([{ port: 80, bind: "0.0.0.0" }]);
      expect(manifest("web").dependsOn).toEqual([
        { name: "cache", condition: "service_healthy" },
        { name: "db", condition: "service_healthy" },
      ]);
      // extends: the worker gets the cache image and its own command.
      expect(readFileSync(join(dirname(serviceJson("worker")), "Dockerfile"), "utf8")).toContain(
        'FROM docker.io/redis:7\nCMD ["redis-server","--port","6380"]\n',
      );
      // Nothing config adds by default leaks into service.json.
      for (const name of ["db", "cache", "powersync", "nginx", "web"]) {
        const text = JSON.stringify(manifest(name));
        expect(text).not.toContain("create_host_path");
        expect(text).not.toContain('"required"');
        expect(text).not.toContain(root);
      }
    },
  );
});

describe("Flisk 1.4.28 fields: dependsOn conditions, buildArgs, logging, env bind paths, SELinux labels, ${NAME:?message}", () => {
  function imported(files: Record<string, string>) {
    tree(files);
    const plan = buildPlan(root);
    const writes = planWrites(plan, false);
    applyWrites(writes);
    return {
      text: formatPlan(plan, writes),
      writes,
      manifest: (name: string) => JSON.parse(readFileSync(serviceJson(name), "utf8")),
    };
  }

  it("writes each Compose condition as a { name, condition } entry, a list entry as service_started", () => {
    const { manifest } = imported({
      "docker-compose.yml": [
        "services:",
        "  web:",
        "    image: app:1",
        "    depends_on:",
        "      db: { condition: service_healthy }",
        "      migrate: { condition: service_completed_successfully }",
        "      cache: {}",
        "  proxy:",
        "    image: caddy:2",
        "    depends_on: [web]",
        "  db: { image: 'postgres:16' }",
        "  migrate: { image: 'app:1', restart: 'no' }",
        "  cache: { image: 'redis:7' }",
      ].join("\n"),
    });
    expect(manifest("web").dependsOn).toEqual([
      { name: "cache", condition: "service_started" },
      { name: "db", condition: "service_healthy" },
      { name: "migrate", condition: "service_completed_successfully" },
    ]);
    expect(manifest("proxy").dependsOn).toEqual([{ name: "web", condition: "service_started" }]);
  });

  it("keeps build.args, and passes an image variable to the generated Dockerfile's ARG (pl_mail database)", () => {
    const { manifest, text } = imported({
      "docker-compose.yml": [
        "services:",
        "  api:",
        "    build:",
        "      context: ./api",
        "      args: { NODE_VERSION: '${NODE_VERSION:-22}', MODE: production }",
        "  worker:",
        "    build:",
        "      context: ./api",
        "      args: ['NODE_VERSION=20', 'EMPTY=']",
        "  database:",
        "    image: postgres:${POSTGRES_VERSION:-18}-alpine",
        "    command: postgres -c max_connections=200",
        "  bad:",
        "    build: { context: ./api, args: { 'not ok': x } }",
      ].join("\n"),
      "api/Dockerfile": "FROM node\n",
    });
    expect(manifest("api").buildArgs).toEqual({
      NODE_VERSION: "${NODE_VERSION:-22}",
      MODE: "production",
    });
    expect(manifest("worker").buildArgs).toEqual({ NODE_VERSION: "20", EMPTY: "" });
    expect(manifest("database").buildArgs).toEqual({ POSTGRES_VERSION: "${POSTGRES_VERSION:-18}" });
    expect(manifest("bad")).not.toHaveProperty("buildArgs");
    expect(text).toContain(
      'service "bad" build.args {"not ok":"x"} has names or values Flisk does not accept',
    );
  });

  it("keeps wger's logging with string options", () => {
    const { manifest, text } = imported({
      "docker-compose.yml": [
        "services:",
        "  web:",
        "    image: docker.io/wger/server:latest",
        "    logging: { driver: json-file, options: { max-size: 10m, max-file: 3 } }",
        "  bad:",
        "    image: app:1",
        "    logging: { driver: 'json file' }",
      ].join("\n"),
    });
    expect(manifest("web").logging).toEqual({
      driver: "json-file",
      options: { "max-size": "10m", "max-file": "3" },
    });
    expect(manifest("bad")).not.toHaveProperty("logging");
    expect(text).toContain(
      'service "bad" logging {"driver":"json file"} has a driver or options Flisk does not accept',
    );
    expect(text).not.toContain("keys not translated: logging");
  });

  it("keeps open-mercato's ${VAR:-./path} bind sources and any-sync's :z / :Z labels", () => {
    const { manifest, text } = imported({
      "docker-compose.yml": [
        "services:",
        "  opencode:",
        "    image: opencode:1",
        "    volumes:",
        "      - ${OM_AGENTS_DIR:-./agents}:/agents:ro",
        "      - ${OM_CERTS-./certs}:/certs",
        "      - ./etc:/etc/any-sync:z",
        "      - ./data:/data:ro,Z",
        "      - type: bind",
        "        source: ./long",
        "        target: /long",
        "        bind: { selinux: z }",
        "      - ${OUTSIDE:-../../elsewhere}:/x",
      ].join("\n"),
    });
    expect(manifest("opencode").volumes).toEqual([
      { source: "${OM_AGENTS_DIR:-../../../agents}", target: "/agents", readOnly: true },
      { source: "${OM_CERTS-../../../certs}", target: "/certs" },
      { source: "../../../etc", target: "/etc/any-sync", selinux: "z" },
      { source: "../../../data", target: "/data", readOnly: true, selinux: "Z" },
      { source: "../../../long", target: "/long", selinux: "z" },
    ]);
    expect(text).toContain("volume /agents reads its path from OM_AGENTS_DIR");
    expect(text).toContain('volume "${OUTSIDE:-../../elsewhere}:/x" is not translated');
  });

  it("writes any-sync's ${NAME:?message} image as it is, with a plain ARG in a generated Dockerfile", () => {
    const { manifest, writes } = imported({
      "docker-compose.yml": [
        "services:",
        "  garage:",
        "    image: 'dxflrs/garage:${GARAGE_VERSION:?set GARAGE_VERSION in .env}'",
        "  wrapped:",
        "    image: 'dxflrs/garage:${GARAGE_VERSION:?set GARAGE_VERSION in .env}'",
        "    command: server",
      ].join("\n"),
    });
    expect(writes.rejected).toEqual([]);
    expect(manifest("garage").image).toBe(
      "dxflrs/garage:${GARAGE_VERSION:?set GARAGE_VERSION in .env}",
    );
    expect(readFileSync(join(dirname(serviceJson("wrapped")), "Dockerfile"), "utf8")).toContain(
      "ARG GARAGE_VERSION\nFROM dxflrs/garage:${GARAGE_VERSION:?set GARAGE_VERSION in .env}\n",
    );
    expect(manifest("wrapped").buildArgs).toEqual({
      GARAGE_VERSION: "${GARAGE_VERSION:?set GARAGE_VERSION in .env}",
    });
  });
});
