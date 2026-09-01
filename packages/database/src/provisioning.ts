import {
  CreateTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
  UpdateTimeToLiveCommand,
  type GlobalSecondaryIndex,
} from "@aws-sdk/client-dynamodb";

import { rawClient } from "./client.ts";
import type { DdbTable, TableDefinition } from "./table.ts";
import { allTables } from "./tables.ts";

/**
 * There are no migrations, and that is a genuine difference rather than an
 * omission: DynamoDB has no schema to migrate. Adding a field is a write. The
 * structural changes are adding a table or an index, which this file performs
 * from the same definitions the access layer uses.
 *
 * Changing an existing KEY is the expensive case -- it means rewriting every
 * item -- which is why the key shape deserves thought before the attributes do.
 */
function attributeDefinitions(definition: TableDefinition) {
  const names = new Set<string>([definition.partitionKey]);
  if (definition.sortKey) names.add(definition.sortKey);
  for (const index of definition.indexes ?? []) {
    names.add(index.partitionKey);
    if (index.sortKey) names.add(index.sortKey);
  }
  // Only key attributes are declared. Everything else is schemaless, which is
  // why adding a normal field needs no change here.
  return [...names].map((name) => ({ AttributeName: name, AttributeType: "S" as const }));
}

function globalSecondaryIndexes(definition: TableDefinition): GlobalSecondaryIndex[] | undefined {
  if (!definition.indexes?.length) return undefined;
  return definition.indexes.map((index) => ({
    IndexName: index.name,
    KeySchema: [
      { AttributeName: index.partitionKey, KeyType: "HASH" as const },
      ...(index.sortKey ? [{ AttributeName: index.sortKey, KeyType: "RANGE" as const }] : []),
    ],
    Projection: { ProjectionType: "ALL" as const },
  }));
}

async function tableStatus(tableName: string) {
  try {
    const described = await rawClient.send(new DescribeTableCommand({ TableName: tableName }));
    return described.Table;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return undefined;
    throw err;
  }
}

/** True when every table exists and is ACTIVE. Backs the readiness probe. */
export async function tablesReady(): Promise<boolean> {
  const statuses = await Promise.all(allTables.map((table) => tableStatus(table.tableName)));
  return statuses.every((table) => table?.TableStatus === "ACTIVE");
}

/**
 * Creates whatever is missing, then waits until everything reports ACTIVE.
 *
 * The wait is not optional. A table can be ACTIVE while its index is still
 * being built, and a Query against a not-yet-ready index fails -- on
 * ScyllaDB's Alternator as a 500, not as anything retryable.
 */
export async function provisionTables(): Promise<string[]> {
  const created: string[] = [];

  for (const table of allTables) {
    const definition = (table as DdbTable<unknown, never>).definition;
    const name = table.tableName;

    if (await tableStatus(name)) continue;

    try {
      await rawClient.send(
        new CreateTableCommand({
          TableName: name,
          // On-demand: no capacity to size, and what a new service should start
          // on. Move to provisioned once there is a load shape to plan for.
          BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: attributeDefinitions(definition),
          KeySchema: [
            { AttributeName: definition.partitionKey, KeyType: "HASH" },
            ...(definition.sortKey
              ? [{ AttributeName: definition.sortKey, KeyType: "RANGE" as const }]
              : []),
          ],
          GlobalSecondaryIndexes: globalSecondaryIndexes(definition),
        }),
      );
      created.push(name);
    } catch (err) {
      // Two processes provisioning at once (a dev server and the test
      // preflight) is normal; losing that race is not an error.
      if ((err as { name?: string }).name !== "ResourceInUseException") throw err;
    }

    if (definition.ttlAttribute) {
      await rawClient
        .send(
          new UpdateTimeToLiveCommand({
            TableName: name,
            TimeToLiveSpecification: { Enabled: true, AttributeName: definition.ttlAttribute },
          }),
        )
        // Alternator reports TTL as already-enabled on re-run; harmless.
        .catch(() => undefined);
    }
  }

  await waitUntilReady();
  return created;
}

async function waitUntilReady(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await tablesReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Tables did not become ACTIVE within ${timeoutMs}ms.`);
}
