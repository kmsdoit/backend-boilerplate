import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import { decodeCursor, encodeCursor } from "./cursor.ts";
import { doc, tableNameFor } from "./client.ts";

export type DdbKey = Record<string, string | number>;
type DdbValues = Record<string, unknown>;
type DdbNames = Record<string, string>;

export type IndexDefinition = {
  name: string;
  partitionKey: string;
  sortKey?: string;
};

/**
 * How a table is keyed. One declaration drives BOTH the typed handle below and
 * `provisionTables()`, so the two cannot drift -- which is a real failure mode
 * when the CreateTable call and the access code are written separately.
 */
export type TableDefinition = {
  /** Logical name. The physical table is `<prefix>-<entity>`. */
  entity: string;
  partitionKey: string;
  sortKey?: string;
  /** Attribute holding a Unix epoch-seconds expiry, for DynamoDB's TTL sweep. */
  ttlAttribute?: string;
  indexes?: IndexDefinition[];
};

export type Page<TRow> = {
  items: TRow[];
  /** Absent when there are no more items. Its presence is the only "has more" signal. */
  nextCursor?: string;
};

/**
 * Typed handle for one table. Repositories compose these and call the methods
 * below; nothing above this file constructs a DynamoDB command.
 *
 * That containment is the point. Command construction, the `Item as TRow`
 * casts, pagination loops, and the `ConditionalCheckFailedException -> null`
 * translation each live in exactly one place instead of being re-derived --
 * slightly differently -- in every repository.
 *
 * `TKey` is the table's real primary-key shape (`{ id: string }`,
 * `{ userId: string; id: string }`), so a wrong or incomplete key is a compile
 * error rather than a runtime `ValidationException`.
 */
export class DdbTable<TRow, TKey extends DdbKey> {
  constructor(readonly definition: TableDefinition) {}

  get tableName(): string {
    return tableNameFor(this.definition.entity);
  }

  async get(key: TKey): Promise<TRow | null> {
    const result = await doc.send(new GetCommand({ TableName: this.tableName, Key: key }));
    return (result.Item as TRow | undefined) ?? null;
  }

  async put(item: TRow, opts?: { conditionExpression?: string }): Promise<void> {
    await doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item as DdbValues,
        ConditionExpression: opts?.conditionExpression,
      }),
    );
  }

  /**
   * Returns false instead of throwing when the condition fails, so a caller can
   * treat "someone else got there first" as a normal outcome. Every other error
   * still propagates.
   */
  async putIfAbsent(item: TRow, keyAttribute: keyof TRow & string): Promise<boolean> {
    try {
      await this.put(item, { conditionExpression: `attribute_not_exists(${keyAttribute})` });
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        return false;
      }
      throw err;
    }
  }

  async delete(key: TKey): Promise<TRow | null> {
    const result = await doc.send(
      new DeleteCommand({ TableName: this.tableName, Key: key, ReturnValues: "ALL_OLD" }),
    );
    return (result.Attributes as TRow | undefined) ?? null;
  }

  /** Unconditional update. DynamoDB upserts when the row is missing, so a row always comes back. */
  async update(opts: {
    key: TKey;
    updateExpression: string;
    expressionAttributeNames?: DdbNames;
    expressionAttributeValues?: DdbValues;
  }): Promise<TRow> {
    const result = await doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: opts.key,
        UpdateExpression: opts.updateExpression,
        ExpressionAttributeNames: opts.expressionAttributeNames,
        ExpressionAttributeValues: opts.expressionAttributeValues,
        ReturnValues: "ALL_NEW",
      }),
    );
    return result.Attributes as TRow;
  }

  /**
   * Conditional update. Returns null iff the condition failed -- which is what
   * "not found", "already deleted" and "lost a race" all look like from here.
   * Every other error propagates.
   */
  async updateIf(opts: {
    key: TKey;
    updateExpression: string;
    conditionExpression: string;
    expressionAttributeNames?: DdbNames;
    expressionAttributeValues?: DdbValues;
    returnValues?: "ALL_NEW" | "ALL_OLD";
  }): Promise<TRow | null> {
    try {
      const result = await doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: opts.key,
          UpdateExpression: opts.updateExpression,
          ConditionExpression: opts.conditionExpression,
          ExpressionAttributeNames: opts.expressionAttributeNames,
          ExpressionAttributeValues: opts.expressionAttributeValues,
          ReturnValues: opts.returnValues ?? "ALL_NEW",
        }),
      );
      return result.Attributes as TRow;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        return null;
      }
      throw err;
    }
  }

  /**
   * One page, with an opaque cursor. Use this for anything a client paginates.
   *
   * There is no total: counting means reading every matching item. Page until
   * `nextCursor` is absent, never until a page looks short -- a filter is
   * applied after the read, so a page can be shorter than `limit` while more
   * items remain.
   */
  async queryPage(opts: {
    keyConditionExpression: string;
    expressionAttributeValues: DdbValues;
    expressionAttributeNames?: DdbNames;
    filterExpression?: string;
    indexName?: string;
    limit: number;
    cursor?: string;
    /** false = descending. With an ISO-8601 sort key that means newest first. */
    scanIndexForward?: boolean;
  }): Promise<Page<TRow>> {
    const result = await doc.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: opts.indexName,
        KeyConditionExpression: opts.keyConditionExpression,
        ExpressionAttributeValues: opts.expressionAttributeValues,
        ExpressionAttributeNames: opts.expressionAttributeNames,
        FilterExpression: opts.filterExpression,
        Limit: opts.limit,
        ExclusiveStartKey: decodeCursor(opts.cursor),
        ScanIndexForward: opts.scanIndexForward,
      }),
    );

    return {
      items: (result.Items ?? []) as TRow[],
      nextCursor: encodeCursor(result.LastEvaluatedKey),
    };
  }

  /**
   * Every row under one partition key, following pagination to the end.
   *
   * Safe only where the partition is bounded by the data model -- "this user's
   * orders", not "every order". For anything a user can grow without limit,
   * use queryPage.
   */
  async queryByPartitionKey(name: keyof TKey & string, value: string | number): Promise<TRow[]> {
    const rows: TRow[] = [];
    let cursor: string | undefined;

    do {
      const page = await this.queryPage({
        keyConditionExpression: `#pk = :pk`,
        expressionAttributeNames: { "#pk": name },
        expressionAttributeValues: { ":pk": value },
        limit: 100,
        cursor,
      });
      rows.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);

    return rows;
  }

  /**
   * Full table scan. Present because seeds and one-off scripts legitimately
   * need it -- never call it from a request handler.
   */
  async scanAll(): Promise<TRow[]> {
    const rows: TRow[] = [];
    let lastKey: DdbValues | undefined;

    do {
      const result = await doc.send(
        new ScanCommand({ TableName: this.tableName, ExclusiveStartKey: lastKey }),
      );
      rows.push(...((result.Items ?? []) as TRow[]));
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);

    return rows;
  }
}
