import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import type { Page, PaginationQuery, UserRole, UserStatus } from "@app/contracts";
import {
  GSI1,
  USER_LIST_PARTITION,
  UniqueConstraintError,
  decodeCursor,
  doc,
  emailKey,
  encodeCursor,
  isConditionalCheckFailed,
  listSortKey,
  tableName,
  userKey,
} from "@app/database";

export type UserRecord = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

export type ListUsersFilter = PaginationQuery & {
  status?: UserStatus;
};

type UserItem = UserRecord & { pk: string; gsi1pk?: string; gsi1sk?: string };

/**
 * All access to users, in one place. Every key string comes from
 * `@app/database`'s keys.ts, so the table layout stays readable in one screen.
 */
export function createUserRepository() {
  async function findById(id: string): Promise<UserRecord | null> {
    const result = await doc.send(
      new GetCommand({ TableName: tableName, Key: { pk: userKey(id) } }),
    );
    const item = result.Item as UserItem | undefined;

    // A soft-deleted user is still addressable by primary key -- only the list
    // index drops it -- so the check has to happen here.
    if (!item || item.deletedAt) {
      return null;
    }
    return toRecord(item);
  }

  /**
   * Creates the user and claims its email address.
   *
   * WHY TWO WRITES AND NOT A TRANSACTION: the DynamoDB idiom is
   * TransactWriteItems([Put user, Put email-lock]), which is atomic.
   * ScyllaDB's Alternator does not implement TransactWriteItems (verified:
   * `UnknownOperationException`), so this uses the pre-transaction pattern
   * instead -- claim the lock with a conditional write, then write the user,
   * and release the lock if that fails.
   *
   * The residual risk is a crash in between, which leaves an orphan lock and
   * makes that address unusable until someone deletes the item. That is the
   * trade for code that runs unchanged on both Alternator and real DynamoDB.
   * Once you are on AWS only, collapse these two writes into a
   * TransactWriteItems and delete this comment.
   */
  async function create(input: {
    id: string;
    email: string;
    name: string;
    role: UserRole;
  }): Promise<UserRecord> {
    const now = new Date().toISOString();
    const email = input.email.trim().toLowerCase();

    try {
      await doc.send(
        new PutCommand({
          TableName: tableName,
          Item: { pk: emailKey(email), userId: input.id },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        throw new UniqueConstraintError("email");
      }
      throw err;
    }

    const item: UserItem = {
      pk: userKey(input.id),
      id: input.id,
      email,
      name: input.name,
      role: input.role,
      status: "active",
      createdAt: now,
      updatedAt: now,
      // Presence of these two is what puts the item in the list index.
      gsi1pk: USER_LIST_PARTITION,
      gsi1sk: listSortKey(now, input.id),
    };

    try {
      await doc.send(
        new PutCommand({
          TableName: tableName,
          Item: item,
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
    } catch (err) {
      // Release the claim rather than leaking it; the address stays usable.
      await doc
        .send(new DeleteCommand({ TableName: tableName, Key: { pk: emailKey(email) } }))
        .catch(() => undefined);
      throw err;
    }

    return toRecord(item);
  }

  async function update(
    id: string,
    changes: { name?: string; role?: UserRole; status?: UserStatus },
  ): Promise<UserRecord | null> {
    const names: Record<string, string> = { "#updatedAt": "updatedAt" };
    const values: Record<string, unknown> = { ":updatedAt": new Date().toISOString() };
    const sets = ["#updatedAt = :updatedAt"];

    // Only the keys actually present are written. Assigning every field would
    // overwrite a real value with undefined on a partial PATCH.
    for (const [field, value] of Object.entries(changes)) {
      if (value === undefined) {
        continue;
      }
      names[`#${field}`] = field;
      values[`:${field}`] = value;
      sets.push(`#${field} = :${field}`);
    }

    try {
      const result = await doc.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: userKey(id) },
          UpdateExpression: `SET ${sets.join(", ")}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          // Fails rather than creating a blank item: UpdateItem is an upsert by
          // default, so without this a PATCH to a deleted id would resurrect it.
          ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(deletedAt)",
          ReturnValues: "ALL_NEW",
        }),
      );
      return toRecord(result.Attributes as UserItem);
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Soft delete. REMOVEing the two index attributes drops the item out of every
   * list query for free -- that is what a sparse GSI buys, versus paying to read
   * deleted items and filter them out afterwards.
   *
   * The email lock is released so the address can be reused, matching the
   * lock item, so the address becomes claimable again.
   */
  async function softDelete(id: string): Promise<UserRecord | null> {
    const now = new Date().toISOString();

    try {
      const result = await doc.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: userKey(id) },
          UpdateExpression: "SET deletedAt = :now, updatedAt = :now REMOVE gsi1pk, gsi1sk",
          ExpressionAttributeValues: { ":now": now },
          ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(deletedAt)",
          ReturnValues: "ALL_OLD",
        }),
      );
      const previous = result.Attributes as UserItem;
      await doc
        .send(new DeleteCommand({ TableName: tableName, Key: { pk: emailKey(previous.email) } }))
        .catch(() => undefined);
      return toRecord(previous);
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Newest first, via the sparse list index.
   *
   * `status` is a FilterExpression, applied AFTER the index read, so a page can
   * come back shorter than `limit` while more items remain. Callers must page
   * until `nextCursor` is absent, never until a page looks short.
   */
  async function list(filter: ListUsersFilter): Promise<Page<UserRecord>> {
    const result = await doc.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: GSI1,
        KeyConditionExpression: "gsi1pk = :partition",
        ExpressionAttributeValues: {
          ":partition": USER_LIST_PARTITION,
          ...(filter.status ? { ":status": filter.status } : {}),
        },
        ...(filter.status
          ? {
              FilterExpression: "#status = :status",
              ExpressionAttributeNames: { "#status": "status" },
            }
          : {}),
        // false = descending, i.e. newest first, because gsi1sk starts with an
        // ISO-8601 timestamp.
        ScanIndexForward: false,
        Limit: filter.limit,
        ExclusiveStartKey: decodeCursor(filter.cursor),
      }),
    );

    return {
      items: ((result.Items ?? []) as UserItem[]).map(toRecord),
      nextCursor: encodeCursor(result.LastEvaluatedKey),
    };
  }

  return { findById, create, update, softDelete, list };
}

/** Strips the key attributes; nothing above this layer should see them. */
function toRecord(item: UserItem): UserRecord {
  const { pk: _pk, gsi1pk: _gsi1pk, gsi1sk: _gsi1sk, ...record } = item;
  return record;
}

export type UserRepository = ReturnType<typeof createUserRepository>;
