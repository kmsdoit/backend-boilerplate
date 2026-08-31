/**
 * Tests for the SCAFFOLDING, not for any domain.
 *
 * Everything here must keep passing after `bun run remove:domain user`, which
 * is why nothing in this file touches a domain route: it exercises the probes,
 * the auth gate, the error shape and the body limit, all of which exist
 * whether or not the API has any routes yet. The example domain's own tests
 * live in user.integration.test.ts and are deleted along with it.
 *
 * Needs the test database (`bun run test:db:up`); pending migrations are
 * applied by the preflight.
 */
import { sign } from "hono/jwt";
import { afterAll, describe, expect, it } from "vitest";

import { applicationConfig } from "@app/config";

import app from "./hono.ts";
import { closeORM } from "../lib/db.ts";

async function request(path: string, init: RequestInit & { token?: string } = {}) {
  const { token, headers, ...rest } = init;
  return app.fetch(
    new Request(`http://localhost${path}`, {
      ...rest,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    }),
  );
}

afterAll(async () => {
  await closeORM();
});

describe("probes", () => {
  it("serves liveness without a token", async () => {
    expect((await request("/health")).status).toBe(200);
  });

  it("serves readiness with the database up", async () => {
    const res = await request("/ready");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "ok",
      checks: [{ name: "database", ok: true }],
    });
  });

  it("exposes Prometheus metrics without a token", async () => {
    const res = await request("/metrics");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("http_requests_total");
  });
});

describe("authentication gate", () => {
  // Deny-by-default: `authenticate` is mounted on "*", so ANY path -- including
  // one with no route behind it -- is rejected without a token. That is what
  // makes a route added tomorrow protected by default.
  it("rejects an unauthenticated request to any path", async () => {
    const res = await request("/anything");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "Authentication required", status: 401 });
  });

  it("rejects a token signed with the wrong secret", async () => {
    const forged = await sign({ sub: "1", role: "admin" }, "a-different-secret-of-sufficient-len");
    expect((await request("/anything", { token: forged })).status).toBe(401);
  });

  it("rejects a token whose issuer does not match", async () => {
    const wrongIssuer = await sign(
      {
        sub: "1",
        role: "admin",
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: "https://attacker.example",
        aud: applicationConfig.auth.audience,
      },
      applicationConfig.auth.jwtSecret,
      "HS256",
    );
    expect((await request("/anything", { token: wrongIssuer })).status).toBe(401);
  });
});

describe("correlation id", () => {
  it("echoes one on every response, authenticated or not", async () => {
    expect((await request("/anything")).headers.get("x-request-id")).toBeTruthy();
  });

  it("reuses an inbound x-request-id so a trace survives across services", async () => {
    const res = await request("/health", { headers: { "x-request-id": "trace-from-upstream" } });
    expect(res.headers.get("x-request-id")).toBe("trace-from-upstream");
  });
});

describe("limits", () => {
  // bodyLimit runs before routing, so this holds with or without any domain.
  it("rejects a body over server.maxBodyBytes with 413 in the standard error shape", async () => {
    const res = await request("/anything", {
      method: "POST",
      body: JSON.stringify({ blob: "x".repeat(2_000_000) }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "Payload too large", status: 413 });
  });
});
