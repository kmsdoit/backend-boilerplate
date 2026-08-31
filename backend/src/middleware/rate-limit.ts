import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

import { applicationConfig } from "@app/config";
import { logger } from "@app/observability";

import type { AppEnv } from "../lib/app-context.ts";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type RateLimiterOptions = {
  windowSeconds: number;
  maxWrites: number;
  /** Injected so a test can drive window rollover from a fixed clock. */
  now?: () => number;
};

type Bucket = {
  count: number;
  /** epoch ms at which this key's window resets. */
  resetAt: number;
};

/**
 * In-memory fixed-window rate limiter for writes. Reads are not throttled --
 * they are cheap and throttling them mostly breaks dashboards.
 *
 * Keyed by actor id, not source IP. This middleware is only ever mounted
 * after `authenticate`, so the actor is always known, and an IP key would
 * lump every caller behind one NAT or proxy into a single bucket while a
 * global counter would let one noisy client starve everyone.
 *
 * LIMITATION -- read this before scaling past one replica. The state lives in
 * *this process's* memory. At one replica the configured limit is the real
 * limit. At N replicas each pod keeps independent counters, so a caller whose
 * requests are spread across pods gets roughly N times the limit. Scaling out
 * means moving this state to Redis or a Postgres table; it does not mean
 * dividing the numbers by N.
 */
export function createRateLimiter(options: RateLimiterOptions): MiddlewareHandler<AppEnv> {
  const { windowSeconds, maxWrites } = options;
  const windowMs = windowSeconds * 1000;
  const now = options.now ?? (() => Date.now());

  const buckets = new Map<string, Bucket>();

  // Sweep once per window rather than on every request. Without it, every
  // actor id ever seen stays in the Map for the life of the process --
  // a slow leak that only shows up in long-running production pods.
  // unref() so this timer can never hold the process (or a test run) open.
  const sweepInterval = setInterval(() => {
    const currentTime = now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= currentTime) {
        buckets.delete(key);
      }
    }
  }, windowMs);
  sweepInterval.unref?.();

  return async (c, next) => {
    if (!WRITE_METHODS.has(c.req.method)) {
      return next();
    }

    const actor = c.get("actor");
    const key = actor?.sub ?? "anonymous";
    const currentTime = now();

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= currentTime) {
      bucket = { count: 0, resetAt: currentTime + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > maxWrites) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - currentTime) / 1000));

      logger.warn("rate limit exceeded", {
        requestId: c.get("requestId"),
        method: c.req.method,
        path: c.req.path,
        actorId: key,
        maxWrites,
        windowSeconds,
      });

      // Retry-After turns a 429 from "try again at random" into something a
      // client can actually back off against.
      c.header("Retry-After", String(retryAfterSeconds));
      throw new HTTPException(429, { message: "Too many requests" });
    }

    return next();
  };
}

export const rateLimiter: MiddlewareHandler<AppEnv> = createRateLimiter(
  applicationConfig.server.rateLimit,
);
