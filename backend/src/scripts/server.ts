#!/usr/bin/env bun
import { logger } from "@app/observability";

import app from "../api/hono.ts";
import { closeORM, initializeORM } from "../lib/db.ts";
import { env } from "../lib/env.ts";

process.title = `${env.SERVICE_NAME}:api`;

/**
 * Connect before serving. Without this the first request pays the connection
 * cost and, worse, a bad DATABASE_URL is not discovered until a user hits an
 * endpoint -- by which point the process has already passed its startup probe
 * and been sent traffic.
 */
await initializeORM();

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
 * ORDER MATTERS, and the obvious order is wrong.
 *
 * Stop the listener FIRST and let in-flight requests drain, and only then
 * close the database pool. Closing the pool first -- the intuitive "release
 * resources" reflex -- kills the queries belonging to the very requests you
 * are trying to let finish, so every deploy returns a handful of 500s to
 * users who were already being served.
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
    await closeORM();
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
