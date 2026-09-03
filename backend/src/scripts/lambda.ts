/**
 * AWS Lambda entrypoint (API Gateway HTTP API v2, or a Function URL).
 *
 *   Handler: backend/src/scripts/lambda.handler
 *
 * Deliberately thin. It shares the exact `app` that src/scripts/server.ts
 * serves, so routes, middleware and error handling cannot drift between the
 * container deployment and the serverless one -- the difference between the
 * two targets is this file and nothing else.
 *
 * WHAT IS DIFFERENT ABOUT RUNNING HERE, and what you must configure:
 *
 * 1. CONNECTIONS. Every warm Lambda container holds its own pool, so the real
 *    connection count is `pool.max` x concurrent containers. At the default
 *    `max: 10` and 100 concurrent invocations that is 1000 connections against
 *    a Postgres whose default `max_connections` is 100. Set `database.pool.max`
 *    to 1 and put RDS Proxy (or PgBouncer) in front. This is the single most
 *    common way a Lambda + Postgres deployment falls over under its first load
 *    spike.
 *
 * 2. NO SHUTDOWN HOOK. Lambda freezes the container between invocations and may
 *    destroy it without warning, so the pool is never closed politely. That is
 *    fine -- Postgres reaps the connection -- but it is why the graceful
 *    shutdown in server.ts is absent here rather than merely unused.
 *
 * 3. THE IN-MEMORY PIECES BECOME PER-CONTAINER. The rate limiter counts per
 *    container, not per caller (use API Gateway throttling or WAF instead), and
 *    `/metrics` reports one container's numbers to whichever scrape happens to
 *    reach it. Ship metrics to CloudWatch EMF or an OTLP collector instead of
 *    scraping.
 *
 * 4. CONFIG WITHOUT A FILESYSTEM. Set `APP_CONFIG` to the YAML itself, or
 *    package `config/application.production.yml` and point `APP_CONFIG_PATH` at
 *    it inside the bundle. Secrets stay in separate `${VAR}` environment
 *    variables either way.
 */
import { handle } from "hono/aws-lambda";

import app from "../api/hono.ts";

export const handler = handle(app);
