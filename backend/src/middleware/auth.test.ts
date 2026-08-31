import { Hono } from "hono";
import { sign } from "hono/jwt";
import { afterEach, describe, expect, it, vi } from "vitest";

import { logger } from "@app/observability";

import type { AppEnv } from "../lib/app-context.ts";
import { createAuthenticator, requireRole } from "./auth.ts";
import { errorHandler } from "./error-handler.ts";

const SECRET = "unit-test-secret-value-at-least-32-characters";

function appWith(options: Parameters<typeof createAuthenticator>[0]) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use("*", createAuthenticator(options));
  app.get("/open", (c) => c.json({ actor: c.get("actor") }));
  app.get("/admin-only", requireRole("admin"), (c) => c.json({ ok: true }));
  return app;
}

async function get(app: Hono<AppEnv>, path: string, token?: string): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
  );
}

describe("createAuthenticator", () => {
  it("attaches the actor from a valid token", async () => {
    const app = appWith({ jwtSecret: SECRET });
    const token = await sign({ sub: "42", role: "member" }, SECRET);

    const res = await get(app, "/open", token);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ actor: { sub: "42", role: "member" } });
  });

  it("rejects a missing or non-bearer authorization header", async () => {
    const app = appWith({ jwtSecret: SECRET });

    expect((await get(app, "/open")).status).toBe(401);
    expect(
      (
        await app.fetch(
          new Request("http://localhost/open", { headers: { authorization: "Basic abc" } }),
        )
      ).status,
    ).toBe(401);
  });

  it("rejects an expired token", async () => {
    const app = appWith({ jwtSecret: SECRET });
    const expired = await sign(
      { sub: "1", role: "admin", exp: Math.floor(Date.now() / 1000) - 60 },
      SECRET,
    );

    expect((await get(app, "/open", expired)).status).toBe(401);
  });

  // The reason iss/aud are configurable rather than hardcoded: this test needs
  // values the shared test config does not set.
  it("enforces issuer and audience once they are configured", async () => {
    const app = appWith({ jwtSecret: SECRET, issuer: "https://auth.example", audience: "api" });

    const right = await sign(
      { sub: "1", role: "admin", iss: "https://auth.example", aud: "api" },
      SECRET,
    );
    const wrong = await sign(
      { sub: "1", role: "admin", iss: "https://evil.example", aud: "api" },
      SECRET,
    );

    expect((await get(app, "/open", right)).status).toBe(200);
    expect((await get(app, "/open", wrong)).status).toBe(401);
  });

  it("gives the same message for every rejection reason", async () => {
    const app = appWith({ jwtSecret: SECRET });
    const wrongSecret = await sign(
      { sub: "1", role: "admin" },
      "another-secret-of-sufficient-length",
    );
    const expired = await sign(
      { sub: "1", role: "admin", exp: Math.floor(Date.now() / 1000) - 60 },
      SECRET,
    );

    const a = (await (await get(app, "/open", wrongSecret)).json()) as { error: string };
    const b = (await (await get(app, "/open", expired)).json()) as { error: string };

    // Distinguishable messages tell an attacker which half of the token to fix.
    expect(a.error).toBe(b.error);
  });

  // The 401/403 split: an unrecognised role is a valid token, so it must not
  // look like an authentication failure.
  it("returns 403, not 401, for a valid token whose role grants nothing", async () => {
    const app = appWith({ jwtSecret: SECRET });
    const token = await sign({ sub: "1", role: "auditor-from-another-service" }, SECRET);

    expect((await get(app, "/open", token)).status).toBe(200);
    expect((await get(app, "/admin-only", token)).status).toBe(403);
  });
});

describe("token redaction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * hono's JWT errors embed the token in their message, so logging it
   * verbatim writes live bearer credentials into the log stream. This pins
   * the redaction; without it the assertion below fails with the real token
   * sitting in the log fields.
   */
  it("never writes a bearer token into a log line", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const app = appWith({ jwtSecret: SECRET });
    const expired = await sign(
      { sub: "1", role: "admin", exp: Math.floor(Date.now() / 1000) - 60 },
      SECRET,
    );

    await get(app, "/open", expired);

    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(expired);
    expect(logged).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    // The diagnostic half survives -- you can still tell WHY it failed.
    expect(logged).toContain("JwtTokenExpired");
    expect(logged).toContain("[redacted-jwt]");
  });
});
