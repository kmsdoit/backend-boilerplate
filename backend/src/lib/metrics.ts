import { Counter, Histogram, Registry } from "@app/observability";

/**
 * The metrics this service exposes, defined next to nothing in particular --
 * on purpose. They live here rather than in @app/observability because a
 * metric and the code that observes it must move together; a metrics package
 * that also owns the metric list drifts from its call sites within a release.
 *
 * Everything is recorded by requestLogger, which sees every request including
 * the ones that fail before reaching a handler.
 */
export const registry = new Registry();

/**
 * Labelled by route *pattern* ("/users/:id"), never by the resolved path
 * ("/users/1834"). A path label turns one time series into one per id, which
 * is the standard way to take down a Prometheus server with your own
 * instrumentation.
 */
export const httpRequestsTotal = registry.register(
  new Counter({
    name: "http_requests_total",
    help: "HTTP requests handled, by method, route pattern and status.",
    labelNames: ["method", "route", "status"],
  }),
);

export const httpRequestDurationSeconds = registry.register(
  new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration in seconds, by method and route pattern.",
    labelNames: ["method", "route"],
    // Retune against real latencies once you have them. Bucket bounds are the
    // one thing you cannot fix retroactively -- the raw observations are gone.
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  }),
);
