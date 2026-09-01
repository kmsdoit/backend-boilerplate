/**
 * Runtime-agnostic half of the config package: schema, `${ENV}` substitution,
 * and validation. Imports NOTHING from node:*, deliberately.
 *
 * WHY THE SPLIT: `@app/config` is imported by almost every module here,
 * including the auth middleware. When this file also imported `node:fs`, that
 * single import made the entire application unbundlable for any runtime
 * without a filesystem, even for code paths that never read a file.
 *
 * src/index.ts adds file loading on top, and is the only file in this package
 * that touches the filesystem. Keeping it that way is what would make an edge
 * target (Cloudflare Workers, Deno Deploy) a small additional entry point
 * rather than a refactor -- see "Serverless" in README.md for what else such a
 * port would cost.
 */
import { parse } from "yaml";
import { z } from "zod";

/**
 * Configuration comes from ONE yaml document and nothing else -- no .env, no
 * dotenv, no scattered `process.env.X ?? default` reads. Two properties fall
 * out of that which are worth keeping:
 *
 *  1. Every knob the service has is visible in one place, with its default
 *     and the reasoning next to it.
 *  2. The process either starts with a fully valid configuration or refuses
 *     to start. There is no "ran for three weeks with a typo'd variable name
 *     silently falling back to a default."
 *
 * Switch environments by pointing APP_CONFIG_PATH at a different file.
 */

const serverConfigSchema = z.object({
  port: z.number().int().min(1).max(65_535).default(3000),

  /**
   * Accepts either a YAML list or a single comma-separated string. The string
   * form exists because `resolveEnvironmentVariables` only substitutes a
   * `${VAR}` placeholder when it is a value's *entire* content -- it does not
   * split a resolved comma list into array elements. One environment variable
   * such as CORS_ORIGINS=https://a.example,https://b.example therefore has to
   * be split here rather than in the YAML.
   */
  corsOrigins: z.preprocess(
    (value) => {
      if (typeof value === "string") {
        return value
          .split(",")
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0);
      }
      return value;
    },
    z.array(z.string().min(1)).default(["http://localhost:5173", "http://localhost:3000"]),
  ),

  /**
   * Upper bound on request body size, in bytes. A JSON API has no inherent
   * size limit, so without this one caller can pin the process's memory with
   * a single request. 1 MiB is generous for a JSON document while still
   * bounding worst-case per-request allocation.
   */
  maxBodyBytes: z.number().int().min(1_024).default(1_048_576),

  /**
   * NOTE: zod v4 does not re-run a `.default()` value through the inner
   * schema's own per-field defaults the way v3 did -- `z.object({ a:
   * z.number().default(1) }).default({})` resolves to `{}`, not `{ a: 1 }`.
   * Nested defaults must therefore be written out fully resolved, as below.
   */
  rateLimit: z
    .object({
      windowSeconds: z.number().int().min(1).default(60),
      maxWrites: z.number().int().min(1).default(30),
    })
    .default({ windowSeconds: 60, maxWrites: 30 }),

  /**
   * Hard ceiling on how long a single request may run before the server gives
   * up on it. Without one, a handler that awaits something that never settles
   * holds its connection (and its database connection) until the client
   * disconnects -- which, for a machine client, may be never. A pool of those
   * is how an API stops answering while every process-level metric looks fine.
   */
  requestTimeoutMs: z.number().int().min(1_000).default(15_000),
});

const baseApplicationConfigSchema = z.object({
  application: z.object({
    /** Used as the service label in logs and metrics. */
    name: z.string().min(1),
    environment: z.enum(["development", "production", "test"]),
  }),
  server: serverConfigSchema.default({
    port: 3000,
    corsOrigins: ["http://localhost:5173", "http://localhost:3000"],
    maxBodyBytes: 1_048_576,
    rateLimit: { windowSeconds: 60, maxWrites: 30 },
    requestTimeoutMs: 15_000,
  }),
  /**
   * DynamoDB, or anything speaking its API -- ScyllaDB's Alternator locally,
   * real DynamoDB in AWS. Only `endpoint` differs between the two, which is
   * the entire reason this stack was chosen: the application code is identical.
   */
  dynamo: z.object({
    /**
     * Omit in AWS so the SDK resolves the regional endpoint itself. Set it to
     * the Alternator address (http://localhost:8000) for local development.
     */
    endpoint: z.string().min(1).optional(),
    region: z.string().min(1).default("us-east-1"),
    /**
     * Prefix for every physical table name (`<prefix>-users`). One table per
     * entity, rather than one shared table with prefixed keys: the key shape
     * then IS the table's type, so a wrong key is a compile error instead of a
     * runtime ValidationException, and an ownership query
     * ("this user's orders") is a plain partition read needing no index.
     */
    tableNamePrefix: z.string().min(1),
    /**
     * Alternator ignores credentials unless started with
     * --alternator-enforce-authorization, but the AWS SDK refuses to sign a
     * request without them, so local development needs placeholders. In AWS,
     * leave these unset and let the SDK use the task/instance role -- putting
     * long-lived keys in config is exactly what that role exists to avoid.
     */
    accessKeyId: z.string().min(1).optional(),
    secretAccessKey: z.string().min(1).optional(),
  }),
  auth: z.object({
    /**
     * 32 characters is the floor for HS256: the HMAC key should be at least
     * as long as the digest it produces (256 bits), or the extra key length
     * an attacker has to guess is smaller than the signature suggests.
     */
    jwtSecret: z.string().min(32),

    /**
     * Optional because a fresh project usually has not decided what its token
     * issuer emits yet. Absent means the check is skipped; present means a
     * mismatch is a 401, same as a bad signature. Do not read "optional" as
     * "this validation is negotiable" -- fill these in as soon as the issuer
     * is real.
     */
    issuer: z.string().min(1).optional(),
    audience: z.string().min(1).optional(),
  }),
});

/**
 * Secrets that ship in this repository's own example configs. None of them may
 * ever reach production.
 *
 * This is not paranoia about a hypothetical: the single most common way a
 * boilerplate leaks is that someone copies the sample config, deploys it, and
 * every JWT in production is signable by anyone who has read the repository.
 * The whole design of this package is "fail at startup, not at request time",
 * and this is the one check that failure mode most deserves.
 */
const PLACEHOLDER_SECRET_MARKERS = ["change-me", "local-development", "test-only"];

/**
 * Cross-field rules, applied after the shape is known to be valid.
 *
 * These live here rather than in the service because a bad combination is a
 * *configuration* error -- it should kill the process at load, next to the
 * file that caused it, not surface later as a confusing runtime behaviour.
 */
const applicationConfigSchema = baseApplicationConfigSchema.superRefine((config, ctx) => {
  if (config.application.environment === "production") {
    const secret = config.auth.jwtSecret.toLowerCase();
    const marker = PLACEHOLDER_SECRET_MARKERS.find((value) => secret.includes(value));
    if (marker) {
      ctx.addIssue({
        code: "custom",
        path: ["auth", "jwtSecret"],
        message: `auth.jwtSecret still contains the example value "${marker}". Supply a real secret (e.g. \${JWT_SECRET}) before deploying.`,
      });
    }
  }

  // `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Credentials:
  // true` are mutually exclusive per the Fetch spec, and browsers reject the
  // pair -- but the failure is a silent CORS error in someone's console, not
  // anything visible server-side. Since this API sends credentials, "*" is
  // always a mistake here, so it is rejected at load instead.
  if (config.server.corsOrigins.includes("*")) {
    ctx.addIssue({
      code: "custom",
      path: ["server", "corsOrigins"],
      message:
        'server.corsOrigins cannot be "*": this API is mounted with credentials, and browsers refuse a wildcard origin on a credentialed request. List the origins explicitly.',
    });
  }
});

export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type ApplicationConfig = z.infer<typeof applicationConfigSchema>;

/**
 * Replaces a string whose entire value is `${SOME_VAR}` with that environment
 * variable, recursively.
 *
 * Whole-value only, by design. Partial interpolation ("host-${ENV}-db") would
 * make it impossible to tell at a glance whether a config value is a literal
 * or a placeholder, and it hides typos: "${DB_URL" is silently a literal.
 *
 * A missing variable throws with both the variable name and the config path
 * that referenced it, because that pair is what someone reading a crashed
 * container's logs actually needs.
 */
function resolveEnvironmentVariables(value: unknown, path = "config"): unknown {
  if (typeof value === "string") {
    const match = /^\$\{([A-Z][A-Z0-9_]*)\}$/.exec(value);
    if (!match) {
      return value;
    }

    const variableName = match[1];
    if (!variableName) {
      return value;
    }

    const resolved = process.env[variableName];
    if (resolved === undefined) {
      throw new Error(`Missing environment variable ${variableName} required by ${path}.`);
    }

    return resolved;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => resolveEnvironmentVariables(item, `${path}[${index}]`));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        resolveEnvironmentVariables(child, `${path}.${key}`),
      ]),
    );
  }

  return value;
}

export function resolveConfigEnvironmentVariables(value: unknown): unknown {
  return resolveEnvironmentVariables(value);
}

/**
 * Parses, resolves `${ENV}` placeholders in, and schema-validates YAML that is
 * already in memory.
 *
 * Split out from the file-reading path so a runtime with no filesystem can
 * still use this package. `source` is named only for error messages.
 */
export function loadApplicationConfigFromYaml(yaml: string, source: string): ApplicationConfig {
  let rawConfig: unknown;
  try {
    rawConfig = resolveEnvironmentVariables(parse(yaml), source);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Missing environment variable")) {
      throw error;
    }
    throw new Error(`Invalid YAML in ${source}.`, { cause: error });
  }

  const result = applicationConfigSchema.safeParse(rawConfig);
  if (!result.success) {
    throw new Error(`Invalid application config at ${source}: ${result.error.message}`);
  }

  return result.data;
}

export { applicationConfigSchema };
