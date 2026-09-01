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
 * WHAT IS DIFFERENT ABOUT RUNNING HERE:
 *
 * 1. NO CONNECTION POOL, and that is why this stack suits Lambda. DynamoDB is
 *    HTTP, so there is nothing to exhaust -- none of the usual "pool.max x
 *    concurrent containers overruns max_connections" failure that sinks a
 *    Lambda-plus-relational-database deployment on its first load spike. The
 *    SDK client is held at module scope (packages/database/src/client.ts) so a
 *    warm invocation reuses its keep-alive connections and cached credentials.
 *
 * 2. NO SHUTDOWN HOOK. Lambda freezes the container between invocations and may
 *    destroy it without warning. Nothing here needs closing, which is why the
 *    graceful shutdown in server.ts is absent rather than merely unused.
 *
 * 3. THE IN-MEMORY PIECES BECOME PER-CONTAINER. The rate limiter counts per
 *    container, not per caller (use API Gateway throttling or WAF instead), and
 *    `/metrics` reports one container's numbers to whichever scrape reaches it.
 *    Ship metrics to CloudWatch EMF or an OTLP collector instead of scraping.
 *
 * 4. CONFIG WITHOUT A FILESYSTEM. Set `APP_CONFIG` to the YAML itself, or
 *    package config/application.production.yml and point `APP_CONFIG_PATH` at
 *    it inside the bundle. Secrets stay in separate `${VAR}` variables either
 *    way, and in AWS you drop `dynamo.endpoint` and the credentials so the SDK
 *    uses the regional endpoint and the task role.
 */
import { handle } from "hono/aws-lambda";

import app from "../api/hono.ts";

export const handler = handle(app);
