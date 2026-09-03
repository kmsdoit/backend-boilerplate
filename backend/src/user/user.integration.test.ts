/**
 * Integration tests for the EXAMPLE domain. `bun run remove:domain user`
 * deletes this file along with the rest of it; the scaffolding's own tests
 * live in app.integration.test.ts and survive.
 *
 * End-to-end through the real Hono app: real middleware chain, real routes,
 * real Postgres. Needs the test database:
 *
 *   bun run test:db:up && bun run test:db:migrate
 *
 * It imports the same `app` object src/scripts/server.ts serves. A test that
 * assembles its own app proves nothing about the one that ships -- most
 * middleware bugs are ordering bugs, and ordering only exists in the real app.
 */
import { sign } from "hono/jwt";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { applicationConfig } from "@app/config";

import app from "../api/hono.ts";
import { closeORM, getEntityManager } from "../lib/db.ts";

async function tokenFor(sub: string, role: string): Promise<string> {
  return sign(
    {
      sub,
      role,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iss: applicationConfig.auth.issuer,
      aud: applicationConfig.auth.audience,
    },
    applicationConfig.auth.jwtSecret,
    "HS256",
  );
}

async function request(
  path: string,
  init: RequestInit & { token?: string | null } = {},
): Promise<Response> {
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

let adminToken: string;

beforeEach(async () => {
  const em = await getEntityManager();
  await em.getConnection().execute("truncate table users");

  // A FRESH actor id per test, deliberately.
  //
  // `rateLimiter` is module-level state built once at import, shared by every
  // test in this file -- exactly as it is shared by every request in a running
  // process. Reusing one actor id means test #4 starts with the write budget
  // test #3 already spent, and fails with a 429 where it expected a 400. That
  // is a real property of the middleware, not a test bug; the isolation has to
  // come from the key.
  adminToken = await tokenFor(crypto.randomUUID(), "admin");
});

afterAll(async () => {
  await closeORM();
});

describe("users CRUD", () => {
  async function createUser(body: Record<string, unknown>): Promise<Response> {
    return request("/users", { method: "POST", token: adminToken, body: JSON.stringify(body) });
  }

  it("creates, reads, updates and soft-deletes", async () => {
    const created = await createUser({ email: "a@example.com", name: "A" });
    expect(created.status).toBe(201);
    const user = (await created.json()) as { id: number; role: string };
    expect(user.role).toBe("member");

    const read = await request(`/users/${user.id}`, { token: adminToken });
    expect(read.status).toBe(200);

    const patched = await request(`/users/${user.id}`, {
      method: "PATCH",
      token: adminToken,
      body: JSON.stringify({ name: "A renamed" }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ name: "A renamed", role: "member" });

    const deleted = await request(`/users/${user.id}`, { method: "DELETE", token: adminToken });
    expect(deleted.status).toBe(204);

    // Soft-deleted rows are invisible to every repository query.
    const afterDelete = await request(`/users/${user.id}`, { token: adminToken });
    expect(afterDelete.status).toBe(404);
  });

  it("never leaks a field the response mapper does not list", async () => {
    const created = await createUser({ email: "shape@example.com", name: "Shape" });
    expect(Object.keys((await created.json()) as object).sort()).toEqual([
      "createdAt",
      "email",
      "id",
      "name",
      "role",
      "status",
      "updatedAt",
    ]);
  });

  it("returns 409 for a duplicate email", async () => {
    await createUser({ email: "dup@example.com", name: "First" });
    const second = await createUser({ email: "dup@example.com", name: "Second" });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: "email already in use" });
  });

  it("frees a soft-deleted user's email for reuse", async () => {
    const first = (await (
      await createUser({ email: "reuse@example.com", name: "First" })
    ).json()) as {
      id: number;
    };
    await request(`/users/${first.id}`, { method: "DELETE", token: adminToken });

    const second = await createUser({ email: "reuse@example.com", name: "Second" });
    expect(second.status).toBe(201);
  });

  it("rejects an unknown body field instead of silently dropping it", async () => {
    const res = await createUser({ email: "x@example.com", name: "X", isAdmin: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid request body" });
  });

  it("rejects an empty PATCH body", async () => {
    const user = (await (await createUser({ email: "p@example.com", name: "P" })).json()) as {
      id: number;
    };
    const res = await request(`/users/${user.id}`, {
      method: "PATCH",
      token: adminToken,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an out-of-range pageSize", async () => {
    const res = await request("/users?pageSize=100000", { token: adminToken });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid query parameters" });
  });

  it("paginates and filters", async () => {
    await createUser({ email: "one@example.com", name: "Findable One", role: "admin" });
    await createUser({ email: "two@example.com", name: "Findable Two" });
    await createUser({ email: "three@example.com", name: "Other" });

    const filtered = await request("/users?q=findable&pageSize=1", { token: adminToken });
    const body = (await filtered.json()) as { items: unknown[]; total: number };
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(1);

    const byRole = await request("/users?role=admin", { token: adminToken });
    expect((await byRole.json()) as { total: number }).toMatchObject({ total: 1 });
  });

  it("stops an admin from suspending their own account", async () => {
    const created = (await (
      await createUser({ email: "self@example.com", name: "Self" })
    ).json()) as {
      id: number;
    };
    const selfToken = await tokenFor(String(created.id), "admin");

    const res = await request(`/users/${created.id}`, {
      method: "PATCH",
      token: selfToken,
      body: JSON.stringify({ status: "suspended" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("rate limiting", () => {
  it("rate limits writes but never reads", async () => {
    // config/application.test.yml sets maxWrites to 5 so this stays short.
    const limitedToken = await tokenFor("rate-limited-actor", "admin");
    const statuses: number[] = [];

    for (let i = 0; i < 7; i++) {
      const res = await request("/users", {
        method: "POST",
        token: limitedToken,
        body: JSON.stringify({ email: `rl${i}@example.com`, name: `RL ${i}` }),
      });
      statuses.push(res.status);
    }

    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);

    const read = await request("/users", { token: limitedToken });
    expect(read.status).toBe(200);
  });
});
