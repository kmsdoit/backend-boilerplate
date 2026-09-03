import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applicationConfig,
  applicationConfigSchema,
  loadApplicationConfigFromPath,
  packageDirectory,
  resolveConfigEnvironmentVariables,
} from "./index.ts";

const configDirectory = resolve(packageDirectory, "../../../config");

describe("applicationConfig", () => {
  it("loads the file APP_CONFIG_PATH points at", () => {
    // The test script sets APP_CONFIG_PATH=./config/application.test.yml.
    expect(applicationConfig.application.environment).toBe("test");
  });
});

describe("sample and production config", () => {
  // Guards against the specific drift where a required field is added to the
  // schema and to config/application.yml, but never to the sample -- so the
  // next person to clone the repo copies a file that no longer validates.
  it("application.sample.yml still satisfies the schema", () => {
    expect(() =>
      loadApplicationConfigFromPath(resolve(configDirectory, "application.sample.yml")),
    ).not.toThrow();
  });

  it("application.production.yml validates once its environment is supplied", () => {
    const previous = { ...process.env };
    Object.assign(process.env, {
      CORS_ORIGINS: "https://app.example.com,https://admin.example.com",
      DATABASE_URL: "postgresql://user:pw@db.example.com:5432/app",
      JWT_SECRET: "a-production-secret-that-is-at-least-32-chars",
      JWT_ISSUER: "https://auth.example.com",
      JWT_AUDIENCE: "backend-boilerplate",
    });

    try {
      const config = loadApplicationConfigFromPath(
        resolve(configDirectory, "application.production.yml"),
      );
      // Pins the comma-split, which is the one place a single env var has to
      // become a list.
      expect(config.server.corsOrigins).toEqual([
        "https://app.example.com",
        "https://admin.example.com",
      ]);
      expect(config.auth.issuer).toBe("https://auth.example.com");
    } finally {
      process.env = previous;
    }
  });

  it("names the missing variable and the path that needed it", () => {
    const previous = { ...process.env };
    delete process.env.DATABASE_URL;
    Object.assign(process.env, {
      CORS_ORIGINS: "https://app.example.com",
      JWT_SECRET: "a-production-secret-that-is-at-least-32-chars",
      JWT_ISSUER: "https://auth.example.com",
      JWT_AUDIENCE: "backend-boilerplate",
    });

    try {
      expect(() =>
        loadApplicationConfigFromPath(resolve(configDirectory, "application.production.yml")),
      ).toThrow(/Missing environment variable DATABASE_URL/);
    } finally {
      process.env = previous;
    }
  });
});

describe("resolveConfigEnvironmentVariables", () => {
  it("substitutes only when the placeholder is the entire value", () => {
    process.env.BOILERPLATE_TEST_VAR = "resolved";
    try {
      expect(
        resolveConfigEnvironmentVariables({
          whole: "${BOILERPLATE_TEST_VAR}",
          // Partial interpolation is deliberately not supported -- it stays
          // a literal rather than becoming "prefix-resolved".
          partial: "prefix-${BOILERPLATE_TEST_VAR}",
          nested: { list: ["${BOILERPLATE_TEST_VAR}", "plain"] },
          untouched: 42,
        }),
      ).toEqual({
        whole: "resolved",
        partial: "prefix-${BOILERPLATE_TEST_VAR}",
        nested: { list: ["resolved", "plain"] },
        untouched: 42,
      });
    } finally {
      delete process.env.BOILERPLATE_TEST_VAR;
    }
  });
});

describe("schema defaults", () => {
  // zod v4 does not fill inner defaults from an empty `.default({})`. This
  // pins that the workaround (fully-resolved nested defaults) actually works,
  // so a future edit back to `.default({})` fails here instead of silently
  // shipping `rateLimit: {}`.
  it("fills nested server defaults when the section is omitted", () => {
    const config = applicationConfigSchema.parse({
      application: { name: "x", environment: "test" },
      database: { url: "postgresql://localhost/x" },
      auth: { jwtSecret: "a-secret-value-that-is-at-least-32-characters" },
    });

    expect(config.server.port).toBe(3000);
    expect(config.server.rateLimit).toEqual({ windowSeconds: 60, maxWrites: 30 });
    expect(config.database.pool).toEqual({ min: 2, max: 10 });
  });

  it("keeps requestTimeoutMs resolved in the server default", () => {
    const config = applicationConfigSchema.parse({
      application: { name: "x", environment: "test" },
      database: { url: "postgresql://localhost/x" },
      auth: { jwtSecret: "a-secret-value-that-is-at-least-32-characters" },
    });

    expect(config.server.requestTimeoutMs).toBe(15_000);
  });

  it("rejects a jwtSecret shorter than 32 characters", () => {
    const result = applicationConfigSchema.safeParse({
      application: { name: "x", environment: "test" },
      database: { url: "postgresql://localhost/x" },
      auth: { jwtSecret: "too-short" },
    });

    expect(result.success).toBe(false);
  });
});

describe("production guards", () => {
  const productionBase = {
    application: { name: "x", environment: "production" as const },
    database: { url: "postgresql://localhost/x" },
    server: { corsOrigins: ["https://app.example.com"] },
  };

  // The single most common way a boilerplate leaks: the sample secret is
  // copied, deployed, and every production token becomes forgeable by anyone
  // who can read the repository.
  it.each([
    "change-me-in-production-at-least-32-chars-please",
    "local-development-only-secret-at-least-32-chars",
    "test-only-secret-value-at-least-32-characters",
  ])("refuses to start in production with the example secret %s", (jwtSecret) => {
    const result = applicationConfigSchema.safeParse({ ...productionBase, auth: { jwtSecret } });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/still contains the example value/);
  });

  it("allows a real secret in production", () => {
    const result = applicationConfigSchema.safeParse({
      ...productionBase,
      auth: { jwtSecret: "9f2c1b7ae4d05386af61c0b2d7e849135ca0be77" },
    });

    expect(result.success).toBe(true);
  });

  // The example secrets are only rejected in production -- development and the
  // test suite depend on them, and that is fine.
  it("allows the example secret outside production", () => {
    const result = applicationConfigSchema.safeParse({
      ...productionBase,
      application: { name: "x", environment: "development" },
      auth: { jwtSecret: "change-me-in-production-at-least-32-chars-please" },
    });

    expect(result.success).toBe(true);
  });

  // "*" plus credentials is rejected by browsers, but only as a console error
  // in someone else's tab -- nothing server-side ever reports it.
  it("rejects a wildcard CORS origin", () => {
    const result = applicationConfigSchema.safeParse({
      ...productionBase,
      server: { corsOrigins: ["*"] },
      auth: { jwtSecret: "9f2c1b7ae4d05386af61c0b2d7e849135ca0be77" },
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/corsOrigins cannot be/);
  });
});

describe("config source precedence", () => {
  afterEach(() => {
    delete process.env.APP_CONFIG;
    vi.resetModules();
  });

  /**
   * Pins the serverless path. This regressed silently once while the package
   * was being split into node/edge entries -- typecheck, lint and all 87 tests
   * stayed green, and it only surfaced when the bundled Lambda was actually
   * invoked and tried to read a file that does not exist inside a bundle.
   */
  it("prefers APP_CONFIG over reading a file", async () => {
    process.env.APP_CONFIG = [
      "application:",
      "  name: from-env",
      "  environment: test",
      "database:",
      "  url: postgresql://localhost/from-env",
      "auth:",
      "  jwtSecret: an-env-supplied-secret-of-at-least-32-chars",
    ].join("\n");

    vi.resetModules();
    const { applicationConfig: loaded } = await import("./index.ts");

    expect(loaded.application.name).toBe("from-env");
    expect(loaded.database.url).toBe("postgresql://localhost/from-env");
  });

  it("still resolves ${ENV} placeholders inside APP_CONFIG", async () => {
    process.env.PLACEHOLDER_DB_URL = "postgresql://localhost/substituted";
    process.env.APP_CONFIG = [
      "application:",
      "  name: from-env",
      "  environment: test",
      "database:",
      "  url: ${PLACEHOLDER_DB_URL}",
      "auth:",
      "  jwtSecret: an-env-supplied-secret-of-at-least-32-chars",
    ].join("\n");

    vi.resetModules();
    const { applicationConfig: loaded } = await import("./index.ts");

    expect(loaded.database.url).toBe("postgresql://localhost/substituted");
    delete process.env.PLACEHOLDER_DB_URL;
  });
});
