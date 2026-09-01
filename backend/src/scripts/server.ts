#!/usr/bin/env bun
import { logger } from "@app/observability";

import { tablesReady } from "@app/database";

import app from "../api/hono.ts";
import { env } from "../lib/env.ts";

process.title = `${env.SERVICE_NAME}:api`;

/**
 * Fail fast on missing tables. There is no connection to open -- the SDK is
 * lazy and stateless -- so without this check a misconfigured endpoint or table
 * name is not discovered until a user hits an endpoint, by which point the
 * process has already passed its startup probe and been sent traffic.
 */
if (!(await tablesReady())) {
  logger.error("tables are missing or not ACTIVE; run `bun run db:provision`");
  process.exit(1);
}

/**
 * Bun.serve() rather than `export default { port, fetch }`, because graceful
 * shutdown needs a handle on the server. Under `bun --hot` Bun reuses the
 * existing listener across reloads, so this stays dev-friendly.
 */
const server = Bun.serve({
  port: env.PORT,
  fetch: app.fetch,
});

/**
 * How long in-flight requests get to finish before the process exits anyway.
 * Must be shorter than the orchestrator's own grace period (Kubernetes
 * `terminationGracePeriodSeconds`, default 30s), or SIGKILL arrives first and
 * this code never gets to run to completion.
 */
const SHUTDOWN_GRACE_MS = 10_000;

let shuttingDown = false;

/**
 * Stop the listener first, then let in-flight requests drain.
 *
 * There is no connection pool to close here -- the DynamoDB SDK is stateless
 * over HTTP -- which removes the ordering hazard a pooled database has, where
 * releasing the pool first kills the very requests you are draining for.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info("shutting down", { signal, graceMs: SHUTDOWN_GRACE_MS });

  // A drain that never finishes must not become a process that never exits;
  // the orchestrator would SIGKILL it anyway, just less predictably.
  const deadline = setTimeout(() => {
    logger.error("shutdown timed out, exiting anyway", { signal });
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  deadline.unref?.();

  try {
    await server.stop();
    logger.info("shutdown complete", { signal });
    process.exit(0);
  } catch (err) {
    logger.error("shutdown failed", {
      signal,
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown(signal));
}

logger.info("server listening", {
  port: server.port,
  environment: env.NODE_ENV,
  service: env.SERVICE_NAME,
});
