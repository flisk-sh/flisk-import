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
      dependsOn: ["db"],
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
    expect(writes.rejected[0]).toMatchObject({ name: "db" });
    expect(text).toContain(
      'not written: db: image "postgres:${PG_VERSION:-16}" uses Compose variables',
    );
    expect(manifest("api")).not.toHaveProperty("dependsOn");
    expect(text).toContain("dependsOn not written, not in this import: db");
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
        "    env_file: .env.api",
        "    volumes: ['./data:/data']",
      ].join("\n"),
    );
    expect(text).toContain('service "api" keys not translated: env_file');
    expect(text).not.toContain("env_file, volumes");
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
    expect(api.secrets).toEqual({ required: ["API_TOKEN", "DATABASE_URL"] });
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
    expect(api?.notes).toContain(
      "no literal value in docker-compose.yml for API_TOKEN; add it to the project .env",
    );
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
      extraPorts: [{ port: 80 }, { port: 443 }, { port: 443, protocol: "udp" }],
    });
    expect(text).toContain("published on 127.0.0.1 only: 80->80/tcp, 443->443/tcp, 443->443/udp");
  });

  it("rewrites bind mounts relative to the service directory and keeps named volumes", () => {
    const { manifest } = plan();
    expect(manifest("caddy").volumes).toEqual([
      { source: "../../../deploy/Caddyfile", target: "/etc/caddy/Caddyfile", readOnly: true },
      { source: "../../../web", target: "/srv/web", readOnly: true },
      { source: "caddy-data", target: "/data" },
    ]);
    expect(manifest("db").volumes).toEqual([
      { source: "postgres-data", target: "/var/lib/postgresql/data" },
    ]);
  });

  it("routes the app's HTTP port and publishes its second listener", () => {
    const { manifest } = plan();
    expect(manifest("app")).toMatchObject({
      port: 3010,
      container: { capAdd: ["NET_ADMIN"], init: true },
      extraPorts: [{ port: 9100 }],
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

  it("commits numbers, booleans, service addresses and ${VAR} references, and keeps the rest secret", () => {
    tree({ "docker-compose.yml": compose });
    const writes = planWrites(buildPlan(root), false);
    applyWrites(writes);
    const app = JSON.parse(readFileSync(serviceJson("app"), "utf8"));
    expect(app.env).toEqual({
      CACHE: "redis:6379",
      ENABLED: "true",
      HT_INVIDIOUS: "http://invidious:3000",
      PORT_HINT: "${APP_PORT:-8080}",
      PROXY: "socks5://tubehaus-vpn:1080",
      PUBLIC_URL: "${APP_URL}",
      RETRIES: "3",
    });
    // A credential name, a URL with a password, an outside address and a free-form string stay out of service.json.
    expect(app.secrets).toEqual({
      required: ["API_KEY", "DB_URL", "EXTERNAL", "MODE", "SESSION_TTL"],
    });
    expect(readFileSync(serviceJson("app"), "utf8")).not.toContain("hunter2");
    const env = readFileSync(join(root, ".env"), "utf8");
    expect(env).toContain("DB_URL=postgres://user:hunter2@invidious-db/app\n");
    expect(env).not.toContain("HT_INVIDIOUS=");
  });

  it("names the variables a committed ${VAR} reference needs, but not one with a default", () => {
    tree({ "docker-compose.yml": compose });
    const writes = planWrites(buildPlan(root), false);
    const notes = writes.items.find((i) => i.service.name === "app")?.notes.join("\n");
    expect(notes).toContain("env reads APP_URL from the project .env; add them there");
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
      'FROM example/app:1\nCMD ["sh","-c","bundle exec rails db:prepare"]\n',
    );
    expect(readFileSync(join(dirname(serviceJson("worker")), "Dockerfile"), "utf8")).toContain(
      'CMD ["bundle","exec","sidekiq"]',
    );
  });

  it("keeps on-failure without its retry limit", () => {
    expect(written()("worker").restart).toBe("on-failure");
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
});
