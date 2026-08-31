import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { AppEnv } from "../lib/app-context.ts";
import { errorHandler } from "./error-handler.ts";
import { createRateLimiter } from "./rate-limit.ts";

/**
 * A fixed clock, injected. Driving window rollover with real time would mean
 * either a sleeping test or a flaky one.
 */
function appWith(maxWrites: number, clock: { value: number }) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use("*", async (c, next) => {
    c.set("actor", { sub: c.req.header("x-actor") ?? "actor-1", role: "admin" });
    await next();
  });
  app.use("*", createRateLimiter({ windowSeconds: 60, maxWrites, now: () => clock.value }));
  app.get("/thing", (c) => c.json({ ok: true }));
  app.post("/thing", (c) => c.json({ ok: true }));
  return app;
}

const post = (app: Hono<AppEnv>, actor = "actor-1") =>
  app.fetch(
    new Request("http://localhost/thing", { method: "POST", headers: { "x-actor": actor } }),
  );

describe("createRateLimiter", () => {
  it("allows writes up to the limit and rejects the next one", async () => {
    const clock = { value: 1_000_000 };
    const app = appWith(3, clock);

    expect((await post(app)).status).toBe(200);
    expect((await post(app)).status).toBe(200);
    expect((await post(app)).status).toBe(200);

    const rejected = await post(app);
    expect(rejected.status).toBe(429);
    // Without Retry-After a client can only guess when to try again.
    expect(Number(rejected.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("never throttles reads", async () => {
    const clock = { value: 1_000_000 };
    const app = appWith(1, clock);
    await post(app);

    for (let i = 0; i < 5; i++) {
      const res = await app.fetch(new Request("http://localhost/thing"));
      expect(res.status).toBe(200);
    }
  });

  // Keyed by actor, so one noisy caller cannot starve everyone else.
  it("counts each actor separately", async () => {
    const clock = { value: 1_000_000 };
    const app = appWith(1, clock);

    expect((await post(app, "noisy")).status).toBe(200);
    expect((await post(app, "noisy")).status).toBe(429);
    expect((await post(app, "quiet")).status).toBe(200);
  });

  it("resets once the window rolls over", async () => {
    const clock = { value: 1_000_000 };
    const app = appWith(1, clock);

    expect((await post(app)).status).toBe(200);
    expect((await post(app)).status).toBe(429);

    clock.value += 60_001;
    expect((await post(app)).status).toBe(200);
  });
});
