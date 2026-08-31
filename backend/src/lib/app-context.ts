import type { Context } from "hono";

import type { Actor } from "./actor.ts";
import { routeFactory, routesFactory } from "./route.ts";

/**
 * Request-scoped values every route can rely on. Add to this only when a
 * genuinely cross-domain concern needs it -- this type is the contract for
 * what "any request" carries, and every entry is something all future
 * middleware has to keep true.
 */
export type AppEnv = {
  Variables: {
    actor: Actor;
    /**
     * Correlation id, set by requestLogger -- which is registered first, ahead
     * of authentication -- so it exists for every request including ones that
     * are rejected before reaching a handler. The error handler reads the same
     * value, so a log line and the response the caller received always carry
     * the same id.
     */
    requestId: string;
    /**
     * performance.now() at request start. Stored rather than recomputed so the
     * error handler can report durationMs even when a handler throws and
     * requestLogger's own post-next() timing never runs.
     */
    requestStart: number;
  };
};

export type AppContext = Context<AppEnv>;

export const route = routeFactory<AppContext>();
export const routes = routesFactory<AppContext>();
