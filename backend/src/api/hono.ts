import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { prettyJSON } from "hono/pretty-json";
import { secureHeaders } from "hono/secure-headers";
import { timeout } from "hono/timeout";

import { applicationConfig } from "@app/config";

import type { AppEnv } from "../lib/app-context.ts";
import { checkReadiness } from "../lib/health.ts";
import { registerToHono } from "../lib/hono-adapter.ts";
import { registry } from "../lib/metrics.ts";
import { authenticate, errorHandler, rateLimiter, requestLogger } from "../middleware/index.ts";
import { api } from "./routes/index.ts";

const app = new Hono<AppEnv>();

// --- Global middleware ---
//
// Order is behaviour, not style. requestLogger is first so every request --
// including ones rejected by CORS, the body limit, or authentication -- has a
// correlation id and a log line.
app.use("*", requestLogger);
app.use("*", prettyJSON());

// nosniff, frame-deny, referrer policy, and friends. Cheap, and the kind of
// thing that only ever gets added after a pentest report asks for it.
// HSTS is left to the TLS terminator in front of this service, which is the
// only component that knows whether HTTPS is actually in play.
app.use("*", secureHeaders());

// Allowed origins are per-environment config, never a NODE_ENV branch in code.
// A hardcoded production branch is how an API ends up shipping with a
// placeholder domain nobody noticed.
app.use("*", cors({ origin: applicationConfig.server.corsOrigins, credentials: true }));

// Mounted globally rather than on the write routes: bodyLimit only inspects
// requests that actually carry a body, so scoping it would duplicate the route
// list for no behavioural gain. Throwing here (rather than returning a
// response) routes the 413 through errorHandler, so it has the same
// {error, status, requestId} shape as every other error.
app.use(
  "*",
  bodyLimit({
    maxSize: applicationConfig.server.maxBodyBytes,
    onError: () => {
      throw new HTTPException(413, { message: "Payload too large" });
    },
  }),
);

// Bounds a single request. Mounted AFTER the probe routes below would be
// wrong -- a probe should be subject to a timeout too -- but it is mounted
// after requestLogger on purpose, so a timed-out request still produces its
// log line and its metric. The 503 it throws flows through errorHandler like
// any other error.
app.use("*", timeout(applicationConfig.server.requestTimeoutMs));

app.onError(errorHandler);

// --- Probes ---
//
// Liveness and readiness must stay separate. Liveness answers "is this process
// wedged, should it be restarted"; it deliberately checks no dependencies,
// because restarting the API does not fix a down database -- it just removes
// the pod that would have served traffic the moment the database returns.
app.get("/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

// Readiness answers "should this instance receive traffic right now" and does
// check dependencies. checkReadiness bounds itself and never throws; the
// try/catch is a hard backstop so a probe can only ever see 200 or 503.
app.get("/ready", async (c) => {
  try {
    const result = await checkReadiness();
    return c.json(
      { status: result.ok ? "ok" : "unavailable", checks: result.checks },
      result.ok ? 200 : 503,
    );
  } catch (err) {
    return c.json(
      { status: "unavailable", error: err instanceof Error ? err.message : String(err) },
      503,
    );
  }
});

// Prometheus scrape endpoint. Unauthenticated because it is mounted before
// `authenticate` below -- expose it on an internal network or a separate port
// before putting this service on the public internet.
app.get("/metrics", (c) =>
  c.text(registry.metricsText(), 200, { "content-type": "text/plain; version=0.0.4" }),
);

// --- Authentication ---
//
// Everything past this line requires a valid token. Deny-by-default: a new
// route is protected the moment it is added, instead of only once someone
// remembers to list it here.
app.use("*", authenticate);

// After authenticate, so the limiter can key on the actor rather than an IP.
app.use("*", rateLimiter);

// --- Domain routes ---
registerToHono(app, api);

export default app;
