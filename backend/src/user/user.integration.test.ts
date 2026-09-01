/**
 * Integration tests for the EXAMPLE domain, end to end through the real Hono
 * app against a real ScyllaDB Alternator. `bun run remove:domain user` deletes
 * this file with the rest of it; the scaffolding's own tests live in
 * api/app.integration.test.ts and survive.
 *
 * Needs the test node (`bun run test:db:up`); the table is provisioned by the
 * preflight.
 */
import { DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { sign } from "hono/jwt";
import { beforeEach, describe, expect, it } from "vitest";

import { applicationConfig } from "@app/config";
import { GSI1, USER_LIST_PARTITION, doc, tableName } from "@app/database";

import app from "../api/hono.ts";

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
  init: RequestInit & { token?: string } = {},
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

/**
 * There is no TRUNCATE in DynamoDB -- deleting means enumerating keys. Only
 * live users are in the index, which is enough to isolate these tests, and
 * doing it through the same index the API reads keeps the helper honest.
 */
async function clearUsers(): Promise<void> {
  const result = await doc.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: GSI1,
      KeyConditionExpression: "gsi1pk = :p",
      ExpressionAttributeValues: { ":p": USER_LIST_PARTITION },
    }),
  );

  for (const item of (result.Items ?? []) as { pk: string; email: string }[]) {
    await doc.send(new DeleteCommand({ TableName: tableName, Key: { pk: item.pk } }));
    await doc.send(new DeleteCommand({ TableName: tableName, Key: { pk: `EMAIL#${item.email}` } }));
  }
}

let adminToken: string;

beforeEach(async () => {
  await clearUsers();
  // A fresh actor id per test: `rateLimiter` is process-wide state shared by
  // every test in this file, so reusing one id means a later test inherits an
  // earlier one's spent write budget and fails with a 429.
  adminToken = await tokenFor(crypto.randomUUID(), "admin");
});

const createUser = (token: string, body: Record<string, unknown>) =>
  request("/users", { method: "POST", token, body: JSON.stringify(body) });

describe("users CRUD", () => {
  it("creates, reads, updates and soft-deletes", async () => {
    const created = await createUser(adminToken, { email: "a@example.com", name: "A" });
    expect(created.status).toBe(201);
    const user = (await created.json()) as { id: string; role: string };
    expect(user.role).toBe("member");
    // The id is a generated uuid, not a sequence: DynamoDB has no serial.
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);

    expect((await request(`/users/${user.id}`, { token: adminToken })).status).toBe(200);

    const patched = await request(`/users/${user.id}`, {
      method: "PATCH",
      token: adminToken,
      body: JSON.stringify({ name: "A renamed" }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ name: "A renamed", role: "member" });

    expect(
      (await request(`/users/${user.id}`, { method: "DELETE", token: adminToken })).status,
    ).toBe(204);
    expect((await request(`/users/${user.id}`, { token: adminToken })).status).toBe(404);
  });

  it("never leaks a key attribute the response mapper does not list", async () => {
    const created = await createUser(adminToken, { email: "shape@example.com", name: "Shape" });
    const body = (await created.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "createdAt",
      "email",
      "id",
      "name",
      "role",
      "status",
      "updatedAt",
    ]);
    // The table layout must never become public API.
    for (const internal of ["pk", "gsi1pk", "gsi1sk", "deletedAt"]) {
      expect(body).not.toHaveProperty(internal);
    }
  });

  it("returns 409 for a duplicate email", async () => {
    await createUser(adminToken, { email: "dup@example.com", name: "First" });
    const second = await createUser(adminToken, { email: "dup@example.com", name: "Second" });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: "email already in use" });
  });

  // Email is lowercased into the lock key, so case cannot be used to bypass it.
  it("treats email uniqueness case-insensitively", async () => {
    await createUser(adminToken, { email: "case@example.com", name: "First" });
    const second = await createUser(adminToken, { email: "CASE@Example.com", name: "Second" });
    expect(second.status).toBe(409);
  });

  it("frees a soft-deleted user's email for reuse", async () => {
    const first = (await (
      await createUser(adminToken, { email: "reuse@example.com", name: "First" })
    ).json()) as { id: string };
    await request(`/users/${first.id}`, { method: "DELETE", token: adminToken });

    expect(
      (await createUser(adminToken, { email: "reuse@example.com", name: "Second" })).status,
    ).toBe(201);
  });

  it("rejects an unknown body field instead of silently dropping it", async () => {
    const res = await createUser(adminToken, {
      email: "x@example.com",
      name: "X",
      isAdmin: true,
    });
    expect(res.status).toBe(400);
  });

  it("rejects an out-of-range limit", async () => {
    const res = await request("/users?limit=100000", { token: adminToken });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid query parameters" });
  });

  it("stops an admin from suspending their own account", async () => {
    const created = (await (
      await createUser(adminToken, { email: "self@example.com", name: "Self" })
    ).json()) as { id: string };
    const selfToken = await tokenFor(created.id, "admin");

    const res = await request(`/users/${created.id}`, {
      method: "PATCH",
      token: selfToken,
      body: JSON.stringify({ status: "suspended" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("cursor pagination", () => {
  it("returns newest first and pages with the cursor", async () => {
    for (const n of [1, 2, 3]) {
      const res = await createUser(adminToken, { email: `p${n}@example.com`, name: `P${n}` });
      expect(res.status).toBe(201);
    }

    const first = await request("/users?limit=2", { token: adminToken });
    const page1 = (await first.json()) as { items: { name: string }[]; nextCursor: string | null };
    expect(page1.items).toHaveLength(2);
    // Newest first: the sort key starts with an ISO timestamp, read descending.
    expect(page1.items[0]?.name).toBe("P3");
    expect(page1.nextCursor).toBeTruthy();

    const second = await request(`/users?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`, {
      token: adminToken,
    });
    const page2 = (await second.json()) as { items: { name: string }[] };
    expect(page2.items.map((i) => i.name)).toEqual(["P1"]);
  });

  // A bad cursor is caller input; it must not become a 500.
  it("treats an unusable cursor as the first page", async () => {
    await createUser(adminToken, { email: "c@example.com", name: "C" });
    const res = await request("/users?cursor=not-a-real-cursor", { token: adminToken });
    expect(res.status).toBe(200);
    expect((await res.json()).items).toHaveLength(1);
  });

  it("drops soft-deleted users out of the list without a filter", async () => {
    const user = (await (
      await createUser(adminToken, { email: "gone@example.com", name: "Gone" })
    ).json()) as { id: string };
    await createUser(adminToken, { email: "stays@example.com", name: "Stays" });

    await request(`/users/${user.id}`, { method: "DELETE", token: adminToken });

    const res = await request("/users", { token: adminToken });
    const body = (await res.json()) as { items: { name: string }[] };
    expect(body.items.map((i) => i.name)).toEqual(["Stays"]);
  });
});

describe("rate limiting", () => {
  it("limits writes but never reads", async () => {
    const limited = await tokenFor(crypto.randomUUID(), "admin");
    const statuses: number[] = [];

    for (let i = 0; i < 7; i++) {
      statuses.push(
        (await createUser(limited, { email: `rl${i}@example.com`, name: `RL${i}` })).status,
      );
    }

    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect((await request("/users", { token: limited })).status).toBe(200);
  });
});
