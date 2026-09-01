#!/usr/bin/env bun
/**
 * Idempotent development seed: `bun run db:seed`.
 *
 * Idempotent matters -- a seed you can only run against an empty table is a
 * seed nobody runs. A conditional Put makes re-running a no-op instead of an
 * error, and does it in one round trip rather than read-then-write.
 */
import { PutCommand } from "@aws-sdk/lib-dynamodb";

import { applicationConfig } from "@app/config";

import { doc, tableName } from "./client.ts";
import { emailKey, listSortKey, userKey, USER_LIST_PARTITION } from "./keys.ts";
import { isConditionalCheckFailed } from "./errors.ts";
import { provisionTable } from "./table.ts";

const SEED_USERS = [
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

if (applicationConfig.application.environment === "production") {
  throw new Error("Refusing to seed a production table.");
}

await provisionTable();

for (const user of SEED_USERS) {
  const now = new Date().toISOString();
  try {
    await doc.send(
      new PutCommand({
        TableName: tableName,
        Item: { pk: emailKey(user.email), userId: user.id },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  } catch (err) {
    if (!isConditionalCheckFailed(err)) {
      throw err;
    }
  }

  // Fixed ids, so re-seeding overwrites the same two items rather than
  // accumulating duplicates every run.
  await doc.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        pk: userKey(user.id),
        ...user,
        status: "active",
        createdAt: now,
        updatedAt: now,
        gsi1pk: USER_LIST_PARTITION,
        gsi1sk: listSortKey(now, user.id),
      },
    }),
  );
  console.log(`seeded ${user.email}`);
}

console.log(`table "${tableName}" ready`);
