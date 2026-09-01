import {
  CreateTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";

import { rawClient, tableName } from "./client.ts";
import { GSI1 } from "./keys.ts";

/**
 * There are no migrations here, and that is a real difference from a
 * relational setup rather than an omission: DynamoDB has no schema to migrate.
 * Adding a field is a write; the only structural change is adding an index,
 * which this function handles by creating the table with the indexes it needs.
 *
 * Changing an existing key layout is the expensive case -- it means rewriting
 * every item -- which is why keys.ts is worth reading before adding a domain.
 */
export async function tableExists(): Promise<boolean> {
  try {
    const described = await rawClient.send(new DescribeTableCommand({ TableName: tableName }));
    return described.Table?.TableStatus === "ACTIVE";
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      return false;
    }
    throw err;
  }
}

/**
 * Creates the table and its index if absent, then waits until both report
 * ACTIVE.
 *
 * The wait is not optional. A table can be ACTIVE while its GSI is still
 * backfilling, and a Query against a not-yet-ready index fails -- on
 * ScyllaDB's Alternator it fails as a 500, not as a retryable error. Provision
 * and then wait, in both the seed path and the test preflight.
 */
export async function provisionTable(): Promise<"created" | "exists"> {
  if (await tableExists()) {
    await waitUntilReady();
    return "exists";
  }

  try {
    await rawClient.send(
      new CreateTableCommand({
        TableName: tableName,
        // On-demand: no capacity to size, and it is what a new service should
        // start on. Switch to provisioned once you have a load shape to plan for.
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "gsi1pk", AttributeType: "S" },
          { AttributeName: "gsi1sk", AttributeType: "S" },
        ],
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        GlobalSecondaryIndexes: [
          {
            IndexName: GSI1,
            KeySchema: [
              { AttributeName: "gsi1pk", KeyType: "HASH" },
              { AttributeName: "gsi1sk", KeyType: "RANGE" },
            ],
            // SPARSE INDEX, and this is load-bearing: an item only appears in
            // gsi1 while it has both gsi1pk and gsi1sk. Soft-deleting a user
            // REMOVEs those two attributes, so the item drops out of every list
            // query for free -- no FilterExpression, no wasted reads, and
            // `Limit` still means what it says.
            Projection: { ProjectionType: "ALL" },
          },
        ],
      }),
    );
  } catch (err) {
    // Two processes provisioning at once (the test preflight and a dev server)
    // is normal; losing that race is not an error.
    if ((err as { name?: string }).name !== "ResourceInUseException") {
      throw err;
    }
  }

  await waitUntilReady();
  return "created";
}

async function waitUntilReady(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const described = await rawClient.send(new DescribeTableCommand({ TableName: tableName }));
      const table = described.Table;
      const indexesReady = (table?.GlobalSecondaryIndexes ?? []).every(
        // Alternator omits IndexStatus on some versions; absent means ready.
        (index: { IndexStatus?: string }) =>
          index.IndexStatus === undefined || index.IndexStatus === "ACTIVE",
      );

      if (table?.TableStatus === "ACTIVE" && indexesReady) {
        return;
      }
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException)) {
        throw err;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Table "${tableName}" did not become ACTIVE within ${timeoutMs}ms.`);
}
