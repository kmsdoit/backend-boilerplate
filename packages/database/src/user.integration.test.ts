/**
 * Needs the test database:
 *   bun run test:db:up && bun run test:db:migrate
 *
 * These assertions cannot be made against a mock -- the behaviour under test
 * belongs to Postgres, not to our code. That is the whole reason this file is
 * an integration test.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { applicationConfig } from "@app/config";

import { User } from "./entities/user.ts";
import { isUniqueViolation, uniqueViolationIndexName } from "./errors.ts";
import { closeORM, getEntityManager } from "./orm.ts";

const databaseOptions = { databaseUrl: applicationConfig.database.url };

async function freshEm() {
  return getEntityManager(databaseOptions);
}

beforeEach(async () => {
  const em = await freshEm();
  await em.getConnection().execute("truncate table users");
});

afterAll(async () => {
  await closeORM();
});

describe("users_active_email_unique", () => {
  it("rejects a second live user with the same email", async () => {
    const em = await freshEm();
    em.persist(em.create(User, { email: "dup@example.com", name: "First" }));
    await em.flush();

    const other = await freshEm();
    other.persist(other.create(User, { email: "dup@example.com", name: "Second" }));

    let caught: unknown;
    try {
      await other.flush();
    } catch (err) {
      caught = err;
    }

    // Matched by errno, never by `instanceof` -- see the TRAP comment in
    // errors.ts for why instanceof silently fails here.
    expect(isUniqueViolation(caught)).toBe(true);
    // MySQL puts the index name only in the message, unlike Postgres which
    // exposes a `constraint` field, so it has to be parsed back out.
    expect(uniqueViolationIndexName(caught as { message: string })).toBe(
      "users_active_email_unique",
    );
  });

  // The point of the partial index: a soft-deleted user must not hold their
  // email address hostage forever.
  it("allows reusing the email of a soft-deleted user", async () => {
    const em = await freshEm();
    const first = em.create(User, { email: "reuse@example.com", name: "First" });
    em.persist(first);
    await em.flush();

    first.deletedAt = new Date();
    await em.flush();

    const other = await freshEm();
    other.persist(other.create(User, { email: "reuse@example.com", name: "Second" }));
    await expect(other.flush()).resolves.toBeUndefined();

    const live = await other.find(User, { email: "reuse@example.com", deletedAt: null });
    expect(live).toHaveLength(1);
    expect(live[0]?.name).toBe("Second");
  });
});

describe("BaseEntity timestamps", () => {
  it("sets createdAt on insert and moves updatedAt on change", async () => {
    const em = await freshEm();
    const user = em.create(User, { email: "ts@example.com", name: "Before" });
    em.persist(user);
    await em.flush();

    const createdAt = user.createdAt;
    const firstUpdatedAt = user.updatedAt;
    expect(createdAt).toBeInstanceOf(Date);

    user.name = "After";
    await em.flush();

    expect(user.createdAt.getTime()).toBe(createdAt.getTime());
    expect(user.updatedAt.getTime()).toBeGreaterThanOrEqual(firstUpdatedAt.getTime());
  });
});
