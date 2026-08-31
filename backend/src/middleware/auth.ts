import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { verify } from "hono/jwt";

import { applicationConfig } from "@app/config";
import { logger } from "@app/observability";

import type { ActorRole } from "../lib/actor.ts";
import { actorSchema } from "../lib/actor.ts";
import type { AppEnv } from "../lib/app-context.ts";
import { env } from "../lib/env.ts";

/**
 * Anything shaped like a JWT, replaced before it reaches a log line.
 *
 * WHY THIS EXISTS: hono's JWT errors embed the offending token in their
 * message ("token (eyJhbGciOi...) expired"), so logging `err.message`
 * verbatim writes bearer tokens into the log stream -- where they are
 * retained, indexed, and readable by anyone with log access. An expired token
 * is low risk; a token rejected for a bad `iss` or a clock-skewed `nbf` is
 * still live, and that is a credential leak with a long tail.
 *
 * The error's class name is kept, since that -- not the token -- is the part
 * that helps someone debugging.
 */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

function redactTokens(message: string): string {
  return message.replace(JWT_PATTERN, "[redacted-jwt]");
}

export type AuthenticatorOptions = {
  jwtSecret: string;
  /**
   * Expected `iss` / `aud`. Optional because a new project often has not
   * decided what its issuer emits yet. Absent means the check is skipped;
   * present means a mismatch is rejected exactly like a bad signature.
   * "Optional" describes the value, never the enforcement.
   */
  issuer?: string;
  audience?: string;
};

/**
 * Built from explicit options rather than reading config at call time, so a
 * test can exercise iss/aud handling with values the shared test config does
 * not set -- no second process, no env var juggling.
 */
export function createAuthenticator(options: AuthenticatorOptions): MiddlewareHandler<AppEnv> {
  const { jwtSecret, issuer, audience } = options;

  return async (c, next) => {
    const header = c.req.header("authorization");
    const [scheme, token] = header?.split(" ") ?? [];

    if (scheme?.toLowerCase() !== "bearer" || !token) {
      logger.warn("authentication failed", {
        requestId: c.get("requestId"),
        method: c.req.method,
        path: c.req.path,
        reason: "no bearer token",
      });
      throw new HTTPException(401, { message: "Authentication required" });
    }

    let claims: unknown;

    try {
      claims = await verify(token, jwtSecret, {
        alg: "HS256",
        ...(issuer ? { iss: issuer } : {}),
        ...(audience ? { aud: audience } : {}),
      });
    } catch (err) {
      // Deliberately one generic message to the caller regardless of whether
      // this was a bad signature, an expired token, or an iss/aud mismatch.
      // Telling an attacker which of the three they got wrong tells them what
      // to fix next. The detail below keeps it for our own logs.
      logger.warn("authentication failed", {
        requestId: c.get("requestId"),
        method: c.req.method,
        path: c.req.path,
        reason: err instanceof Error ? err.constructor.name : "unknown",
        detail: redactTokens(err instanceof Error ? err.message : String(err)),
      });
      throw new HTTPException(401, { message: "Invalid or expired token" });
    }

    const actor = actorSchema.safeParse(claims);

    if (!actor.success) {
      logger.warn("authentication failed", {
        requestId: c.get("requestId"),
        method: c.req.method,
        path: c.req.path,
        reason: "token claims did not match actorSchema",
        issues: actor.error.issues,
      });
      throw new HTTPException(401, { message: "Invalid or expired token" });
    }

    c.set("actor", actor.data);

    await next();
  };
}

export const authenticate: MiddlewareHandler<AppEnv> = createAuthenticator({
  jwtSecret: env.JWT_SECRET,
  issuer: applicationConfig.auth.issuer,
  audience: applicationConfig.auth.audience,
});

/**
 * Authorisation, kept separate from authentication so the 401/403 split stays
 * honest: 401 means "I do not know who you are", 403 means "I know exactly who
 * you are and the answer is no".
 */
export function requireRole(...allowed: readonly ActorRole[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = c.get("actor");

    if (!actor) {
      throw new HTTPException(401, { message: "Authentication required" });
    }

    // `allowed` is typed as ActorRole[] so call sites stay typo-safe, but
    // actor.role is a plain string (this service does not own the role
    // vocabulary -- see lib/actor.ts), so the comparison widens to string.
    if (!(allowed as readonly string[]).includes(actor.role)) {
      logger.warn("authorization failed", {
        requestId: c.get("requestId"),
        method: c.req.method,
        path: c.req.path,
        actorId: actor.sub,
        actorRole: actor.role,
      });
      throw new HTTPException(403, { message: "Insufficient permissions" });
    }

    await next();
  };
}

export const requireAdmin = requireRole("admin");
