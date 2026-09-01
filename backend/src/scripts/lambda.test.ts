/**
 * Exercises the real Lambda handler with a real API Gateway v2 event, so the
 * serverless target cannot silently break while the container target stays
 * green. No AWS involved -- `handle()` is an ordinary function.
 *
 * Needs the test database, like the other integration tests.
 */
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";

import { applicationConfig } from "@app/config";

import { handler } from "./lambda.ts";

type LambdaResult = { statusCode: number; body: string; headers?: Record<string, string> };

function event(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Record<string, unknown> {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: "",
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    requestContext: {
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1" },
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    isBase64Encoded: false,
  };
}

async function invoke(...args: Parameters<typeof event>): Promise<LambdaResult> {
  return (await handler(event(...args) as never, {} as never)) as LambdaResult;
}

describe("lambda handler", () => {
  it("serves liveness", async () => {
    const res = await invoke("GET", "/health");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: "ok" });
  });

  it("reaches the table through readiness", async () => {
    const res = await invoke("GET", "/ready");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ checks: [{ name: "dynamo", ok: true }] });
  });

  // The same middleware chain must apply here as under Bun.serve -- that is
  // the whole reason both targets share one `app`.
  it("applies the auth gate", async () => {
    const res = await invoke("GET", "/no-such-route");
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ error: "Authentication required", status: 401 });
  });

  // Deliberately asserts 404 rather than hitting a domain route: this file
  // tests the serverless ADAPTER, and must keep passing after
  // `remove:domain user` like every other scaffolding test. A 404 (rather
  // than the 401 above) is exactly the proof wanted here -- the token was
  // accepted and the request reached routing.
  it("accepts a valid token, so the request reaches routing", async () => {
    const token = await sign(
      {
        sub: crypto.randomUUID(),
        role: "admin",
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: applicationConfig.auth.issuer,
        aud: applicationConfig.auth.audience,
      },
      applicationConfig.auth.jwtSecret,
      "HS256",
    );

    const res = await invoke("GET", "/no-such-route", { token });
    expect(res.statusCode).toBe(404);
  });
});
