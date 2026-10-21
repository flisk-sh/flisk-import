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
      web: svc({ match: { image: "nginx:1.27", port: 4000, healthCheckPath: "/" } }, routed),
    },
    plan: ["Compose port 80 is outside 4000-5999 or already used", "health:    / (assumed)"],
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
      wordpress: svc({ match: { port: 4001, dependsOn: ["db-svc"] } }, routed),
      "db-svc": svc({ match: { image: "mysql:8", port: 4000 } }, privateSvc),
    },
    plan: ["keys not translated: volumes"],
  },
  "gitea-postgres": {
    services: {
      gitea: svc({ match: { port: 4001, dependsOn: ["db-svc"] } }, routed),
      "db-svc": privateSvc,
    },
    plan: ["publishes extra container ports (22)"],
  },
  "redis-only": {
    services: { cache: svc({ match: { image: "redis:7", port: 4000 } }, privateSvc) },
  },
  "rails-sidekiq": {
    services: {
      web: svc(
        { match: { buildContext: "../../..", port: 4002, dependsOn: ["db-svc", "redis"] } },
        routed,
      ),
      sidekiq: svc({ match: { buildContext: "../../.." } }, privateSvc),
      "db-svc": { match: { exposeViaProxy: false, port: 5432 }, without: ["healthCheckPath"] },
      redis: privateSvc,
    },
    plan: ["keys not translated: command"],
  },
  "django-celery": {
    services: {
      web: svc({ match: { port: 4001, buildContext: "../../../backend" } }, routed),
      worker: svc({ match: { dependsOn: ["db-svc"] } }, privateSvc),
      "db-svc": privateSvc,
    },
    plan: ["Compose port 8000 is outside 4000-5999 or already used; assigned 4001"],
  },
  "spring-boot-mysql": {
    services: {
      app: svc(
        { match: { port: 4000, healthCheckPath: "/actuator/health", dependsOn: ["db-svc"] } },
        routed,
      ),
      "db-svc": privateSvc,
    },
  },
  "interpolated-image": {
    services: { api: { without: ["dependsOn"] } },
    notWritten: ["db"],
    plan: [
      'image "postgres:${PG_VERSION:-16}" uses Compose variables',
      "dependsOn not written, not in this import: db",
    ],
  },
  "interpolated-port": {
    services: { app: privateSvc },
    plan: ["ports not understood"],
  },
  "partly-unreadable-ports": {
    services: { app: svc({ match: { port: 4000 } }, routed) },
    plan: ["port entries that were not understood and ignored", "only 8080 was read"],
  },
  "profiles-and-extends": {
    services: { web: { match: { port: 4000 } } },
    notWritten: ["debug", "api2"],
    plan: ['service "debug" has profiles', 'service "api2" uses `extends`'],
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
    services: { api: { match: { port: 4000 } }, worker: privateSvc },
    plan: ["environment values are not written"],
  },
  "privileged-ports": {
    services: { one: { match: { port: 4000 } }, two: { match: { port: 4001 } } },
  },
  "shared-port": {
    services: { "a-svc": { match: { port: 4000 } }, "b-svc": { match: { port: 4001 } } },
  },
  "long-syntax-ports": {
    // `target` is the container port (8080); `published: 80` is the host side and does not matter.
    services: { api: { match: { port: 4000 } } },
    plan: ["Compose port 8080 is outside 4000-5999 or already used; assigned 4000"],
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
      zookeeper: svc({ match: { port: 4002 } }, privateSvc),
      kafka: svc({ match: { port: 4001, dependsOn: ["zookeeper"] } }, privateSvc),
      kafdrop: svc({ match: { port: 4000, dependsOn: ["kafka"] } }, routed),
    },
  },
  "mongo-express": {
    services: {
      mongo: privateSvc,
      express: svc({ match: { port: 4000, dependsOn: ["mongo"] } }, routed),
    },
  },
  "missing-dependency": {
    services: { api: { without: ["dependsOn"] } },
    plan: ["dependsOn not written, not in this import: ghost"],
  },
  "all-skipped": { exit: 1, notWritten: ["only"], plan: ['service "only" has profiles'] },
  "invalid-yaml": { exit: 1, plan: ["invalid YAML"] },
};
