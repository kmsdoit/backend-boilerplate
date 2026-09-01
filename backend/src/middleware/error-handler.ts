import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";

import { logger } from "@app/observability";

import type { AppEnv } from "../lib/app-context.ts";
import { env } from "../lib/env.ts";

/**
 * The single place an error becomes an HTTP response. Every route throws; none
 * of them formats a response body, so the shape below is guaranteed identical
 * across the whole API -- including for errors thrown by middleware before any
 * route ran.
 */
export const errorHandler: ErrorHandler<AppEnv> = (rawErr, c) => {
  // requestLogger runs first in the chain, so these are always set in the real
  // app. The fallbacks matter only when this function is exercised directly by
  // a unit test.
  const requestId = c.get("requestId") ?? c.req.header("x-request-id") ?? crypto.randomUUID();
  const requestStart = c.get("requestStart");
  const durationMs =
    typeof requestStart === "number"
      ? Number((performance.now() - requestStart).toFixed(1))
      : undefined;

  const err: Error = rawErr;

  c.header("x-request-id", requestId);

  if (err instanceof HTTPException) {
    logger.log(err.status >= 500 ? "error" : "warn", "request failed", {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: err.status,
      durationMs,
      error: err.message,
    });
    return c.json({ error: err.message, status: err.status, requestId }, err.status);
  }

  logger.error("request failed", {
    requestId,
    method: c.req.method,
    path: c.req.path,
    status: 500,
    durationMs,
    error: err.message,
    stack: err.stack,
  });

  return c.json(
    {
      // The real message goes to the logs either way. It reaches the *caller*
      // only outside production, where an unexpected error's text can name an
      // internal host, a table, or a query.
      error: env.NODE_ENV === "production" ? "Internal Server Error" : err.message,
      status: 500,
      requestId,
    },
    500,
  );
};
