import type { MiddlewareHandler } from "hono";

import { logger } from "@app/observability";

import type { AppEnv } from "../lib/app-context.ts";
import { httpRequestDurationSeconds, httpRequestsTotal } from "../lib/metrics.ts";

/**
 * Request logging, correlation id, and HTTP metrics.
 *
 * Registered FIRST in the middleware chain -- ahead of authentication -- so
 * every request gets an id and a log line, including the ones rejected as
 * unauthenticated. Those are usually the requests you most want a record of.
 *
 * The id is reused from an inbound `x-request-id` when present, so a trace
 * survives across services, and echoed back on the response so a caller can
 * quote it in a bug report.
 */
export const requestLogger: MiddlewareHandler<AppEnv> = async (c, next) => {
  const start = performance.now();
  const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
  c.set("requestId", requestId);
  c.set("requestStart", start);

  await next();

  c.header("x-request-id", requestId);

  const durationMs = Number((performance.now() - start).toFixed(1));
  const status = c.res.status;
  const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";

  // The route *pattern* ("/users/:id"), not the resolved path -- see the
  // comment on httpRequestsTotal. "/*" means no handler ran: either nothing
  // matched, or middleware rejected the request first (401, 413). Those all
  // collapse into one "unmatched" bucket rather than creating a time series
  // per URL an attacker probes.
  const route = c.req.routePath === "/*" ? "unmatched" : c.req.routePath;

  httpRequestsTotal.inc({ method: c.req.method, route, status: String(status) });
  httpRequestDurationSeconds.observe({ method: c.req.method, route }, durationMs / 1000);

  logger.log(level, "request completed", {
    requestId,
    method: c.req.method,
    path: c.req.path,
    route,
    status,
    durationMs,
  });
};
