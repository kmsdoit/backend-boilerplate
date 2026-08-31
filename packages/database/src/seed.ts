#!/usr/bin/env bun
/**
 * Idempotent development seed: `bun run db:seed`.
 *
 * Idempotent matters -- a seed you can only run against an empty database is
 * a seed nobody runs. Re-running this updates the existing rows instead of
 * failing on the unique index.
 */
import { applicationConfig } from "@app/config";

import { User } from "./entities/user.ts";
import { closeORM, getEntityManager } from "./orm.ts";

const SEED_USERS = [
  { email: "admin@example.com", name: "Admin", role: "admin" as const },
  { email: "member@example.com", name: "Member", role: "member" as const },
];

async function seed(): Promise<void> {
  if (applicationConfig.application.environment === "production") {
    throw new Error("Refusing to seed a production database.");
  }

  const em = await getEntityManager({ databaseUrl: applicationConfig.database.url });

  for (const seedUser of SEED_USERS) {
    const existing = await em.findOne(User, { email: seedUser.email, deletedAt: null });

    if (existing) {
      existing.name = seedUser.name;
      existing.role = seedUser.role;
      console.log(`updated ${seedUser.email}`);
    } else {
      em.persist(em.create(User, { ...seedUser, status: "active" }));
      console.log(`created ${seedUser.email}`);
    }
  }

  await em.flush();
  console.log(`seeded ${SEED_USERS.length} users into ${applicationConfig.application.name}`);
}

try {
  await seed();
} finally {
  await closeORM();
}
