#!/usr/bin/env bun
/**
 * Idempotent development seed: `bun run db:seed`.
 *
 * Idempotent matters -- a seed you can only run against empty tables is a seed
 * nobody runs. Fixed ids mean re-running overwrites the same two rows instead
 * of accumulating duplicates.
 */
import { applicationConfig } from "@app/config";

import { provisionTables } from "./provisioning.ts";
import { USER_LIST_PARTITION, tables, type UserRow } from "./tables.ts";

if (applicationConfig.application.environment === "production") {
  throw new Error("Refusing to seed production tables.");
}

await provisionTables();

const SEED_USERS: Pick<UserRow, "id" | "email" | "name" | "role">[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    email: "admin@example.com",
    name: "Admin",
    role: "admin",
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    email: "member@example.com",
    name: "Member",
    role: "member",
  },
];

for (const seed of SEED_USERS) {
  const now = new Date().toISOString();
  await tables.userEmails.putIfAbsent({ email: seed.email, userId: seed.id }, "email");
  await tables.users.put({
    ...seed,
    status: "active",
    createdAt: now,
    updatedAt: now,
    listPartition: USER_LIST_PARTITION,
    listSortKey: `${now}#${seed.id}`,
  });
  console.log(`seeded ${seed.email}`);
}

console.log(`${applicationConfig.application.name} ready`);
