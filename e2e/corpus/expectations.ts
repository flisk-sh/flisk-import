/**
 * What each fixture in this directory must import to. The Compose files are written for this test in
 * the shape of well-known stacks (WordPress, Gitea, Rails + Sidekiq, Kafka, ...); they are not copies.
 * `services` lists the manifests that must be written, as partial matches; `without` lists fields that
 * must be absent. `plan` is text the printed plan must contain.
 */
export interface ServiceCheck {
  match?: Record<string, unknown>;
  without?: string[];
}

export interface Expectation {
  exit?: number;
  services?: Record<string, ServiceCheck>;
  /** Services that must not be written. */
  notWritten?: string[];
  plan?: string[];
}

/** Reached through Traefik: no `exposeViaProxy: false`. */
const routed: ServiceCheck = { without: ["exposeViaProxy"] };
/** No route and no health path. */
const privateSvc: ServiceCheck = { match: { exposeViaProxy: false }, without: ["healthCheckPath"] };
const svc = (check: ServiceCheck, base: ServiceCheck): ServiceCheck => ({
  match: { ...base.match, ...check.match },
  without: [...(base.without ?? []), ...(check.without ?? [])],
});

export const EXPECTATIONS: Record<string, Expectation> = {
  "nginx-static": {
    services: {
      web: svc({ match: { image: "nginx:1.27", port: 80, healthCheckPath: "/" } }, routed),
    },
    plan: ["port:      80", "health:    / (assumed)"],
  },
  "node-api-build": {
    services: {
      api: svc(
        {
          match: {
            buildContext: "../../../api",
            dockerfile: "Dockerfile",
            port: 4000,
            healthCheckPath: "/health",
          },
          without: ["image"],
        },
        routed,
      ),
    },
  },
  "wordpress-mysql": {
    services: {
      wordpress: svc(
        {
          match: {
            port: 80,
            dependsOn: [{ name: "db" }],
            volumes: [{ source: "wp", target: "/var/www/html" }],
          },
        },
        routed,
      ),
      db: svc({ match: { image: "mysql:8", port: 3306 } }, privateSvc),
    },
    plan: ["wordpress  (service)"],
  },
  "gitea-postgres": {
    services: {
      gitea: svc({ match: { port: 3000, dependsOn: [{ name: "db" }] } }, routed),
      db: privateSvc,
    },
    plan: ["publishes extra container ports (22)"],
  },
  "redis-only": {
    services: { cache: svc({ match: { image: "redis:7", port: 6379 } }, privateSvc) },
  },
  "rails-sidekiq": {
    services: {
      web: svc(
        {
          match: {
            buildContext: "../../..",
            port: 3000,
            dependsOn: [{ name: "db" }, { name: "redis" }],
          },
        },
        routed,
      ),
      sidekiq: svc(
        {
          match: {
            buildContext: "../../..",
            container: { command: ["bundle", "exec", "sidekiq"] },
          },
        },
        privateSvc,
      ),
      db: { match: { exposeViaProxy: false, port: 5432 }, without: ["healthCheckPath"] },
      redis: privateSvc,
    },
    plan: ["build:     ./ with Dockerfile"],
  },
  "django-celery": {
    services: {
      web: svc({ match: { port: 8000, buildContext: "../../../backend" } }, routed),
      worker: svc({ match: { dependsOn: [{ name: "db" }] } }, privateSvc),
      db: privateSvc,
    },
    plan: ["port:      8000"],
  },
  "spring-boot-mysql": {
    services: {
      app: svc(
        { match: { port: 8080, healthCheckPath: "/actuator/health", dependsOn: [{ name: "db" }] } },
        routed,
      ),
      db: svc({ match: { port: 3306 } }, privateSvc),
    },
  },
  "interpolated-image": {
    services: {
      api: { match: { dependsOn: [{ name: "db" }] } },
      db: svc({ match: { image: "postgres:${PG_VERSION:-16}" } }, privateSvc),
    },
    plan: ["image:     postgres:${PG_VERSION:-16}"],
  },
  "lychee-round-trip": {
    services: {
      "lychee-api": svc(
        {
          match: {
            port: 8000,
            healthCheckPath: "/up",
            healthCheck: {
              command: ["curl", "-f", "http://localhost:8000/up"],
              interval: 30,
              timeout: 10,
              retries: 3,
              startPeriod: 60,
            },
            extraPorts: [{ port: 8000, publish: "${APP_PORT:-8000}" }],
            container: { networkAliases: ["lychee_api"] },
            env: {
              APP_URL: "${APP_URL:-http://localhost:${APP_PORT:-8000}}",
              DB_HOST: "lychee_db",
              DB_PASSWORD: "${DB_PASSWORD:-password}",
              LOG_VIEWER_CACHE_DRIVER: "file",
              VISION_FACE_STORAGE_BACKEND: "sqlite",
            },
            dependsOn: [{ name: "lychee-db" }],
          },
          without: ["secrets"],
        },
        routed,
      ),
      "lychee-db": svc(
        {
          match: {
            image: "mariadb:${MARIADB_VERSION:-11}",
            healthCheck: { command: ["healthcheck.sh", "--connect"], startPeriod: 30 },
            env: { MYSQL_ROOT_PASSWORD: "${DB_ROOT_PASSWORD:-rootpassword}" },
            secrets: { required: ["MYSQL_PASSWORD"] },
            container: { networkAliases: ["lychee_db"] },
          },
        },
        privateSvc,
      ),
      "lychee-worker": svc(
        {
          match: {
            env: { LYCHEE_MODE: "worker", DB_HOST: "lychee_db" },
            dependsOn: [{ name: "lychee-api" }],
          },
        },
        privateSvc,
      ),
    },
    plan: ['renamed from "lychee_api"'],
  },
  "interpolated-port": {
    services: { app: privateSvc },
    plan: ["ports not understood"],
  },
  "partly-unreadable-ports": {
    services: { app: svc({ match: { port: 8080 } }, routed) },
    plan: ["port entries that were not understood and ignored", "only 8080 was read"],
  },
  "profiles-and-extends": {
    services: { web: { match: { port: 4000 } }, debug: { match: { profiles: ["debug"] } } },
    notWritten: ["api2"],
    plan: ['service "api2" uses `extends`'],
  },
  "out-of-tree-build": {
    services: { web: { match: { port: 4001 } } },
    notWritten: ["api"],
    plan: ['build context "../shared" is outside the imported directory'],
  },
  "override-present": {
    services: { api: { match: { port: 4000 } } },
    plan: ["docker-compose.override.yml [compose]: not applied"],
  },
  "yaml-anchors": {
    services: { "a-svc": { match: { port: 4000 } }, "b-svc": { match: { port: 4001 } } },
    plan: ["uses YAML anchors/aliases"],
  },
  "env-secrets": {
    services: {
      api: { match: { port: 4000, secrets: { required: ["API_KEY", "PLAIN"] } } },
      worker: svc({ match: { secrets: { required: ["DB_URL"] } } }, privateSvc),
    },
    plan: ["env:       API_KEY, PLAIN"],
  },
  "privileged-ports": {
    services: { one: { match: { port: 80 } }, two: { match: { port: 81 } } },
  },
  "shared-port": {
    // Each service has its own container, so both keep the Compose port.
    services: { "a-svc": { match: { port: 4000 } }, "b-svc": { match: { port: 4000 } } },
  },
  "long-syntax-ports": {
    // `target` is the container port (8080); `published: 80` is the host side and does not matter.
    services: { api: { match: { port: 8080 } } },
    plan: ["port:      8080"],
  },
  "build-and-image": {
    services: {
      app: {
        match: { buildContext: "../../../app", dockerfile: "Dockerfile" },
        without: ["image"],
      },
    },
  },
  "custom-dockerfile": {
    services: {
      svc: { match: { buildContext: "../../../svc", dockerfile: "docker/Dockerfile.prod" } },
    },
  },
  "bad-health-path": {
    services: { api: { match: { healthCheckPath: "/" } } },
    plan: ['health path "/health_check" has characters Flisk does not accept'],
  },
  "worker-no-ports": {
    services: { jobs: svc({ match: { buildContext: "../../.." } }, privateSvc) },
  },
  "kafka-zookeeper": {
    services: {
      zookeeper: svc({ match: { port: 2181 } }, privateSvc),
      kafka: svc({ match: { port: 9092, dependsOn: [{ name: "zookeeper" }] } }, privateSvc),
      kafdrop: svc({ match: { port: 9000, dependsOn: [{ name: "kafka" }] } }, routed),
    },
  },
  "mongo-express": {
    services: {
      mongo: privateSvc,
      express: svc({ match: { port: 8081, dependsOn: [{ name: "mongo" }] } }, routed),
    },
  },
  "missing-dependency": {
    services: { api: { without: ["dependsOn"] } },
    plan: ["dependsOn not written, not in this import: ghost"],
  },
  "all-skipped": { exit: 1, notWritten: ["only"], plan: ['service "only" uses `extends`'] },
  "invalid-yaml": { exit: 1, plan: ["invalid YAML"] },
};
