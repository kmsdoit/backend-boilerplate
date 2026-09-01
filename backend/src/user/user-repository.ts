import type { PaginationQuery, UserRole, UserStatus } from "@app/contracts";
import { USER_LIST_PARTITION, tables, type Page, type UserRow } from "@app/database";

export type ListUsersFilter = PaginationQuery & {
  status?: UserStatus;
};

/**
 * All access to users. Notice there is not a single DynamoDB command in this
 * file: `DdbTable` owns command construction, the casts, and the
 * ConditionalCheckFailed translation, so a repository reads as domain logic.
 *
 * Tables are injected rather than imported, so a test can hand this fakes.
 */
export class UserRepository {
  constructor(
    private readonly users = tables.users,
    private readonly emails = tables.userEmails,
  ) {}

  async findById(id: string): Promise<UserRow | null> {
    const user = await this.users.get({ id });
    // A soft-deleted user is still addressable by primary key -- only the list
    // index drops it -- so the check has to happen here.
    return user && !user.deletedAt ? user : null;
  }

  /**
   * Creates the user and claims its email address.
   *
   * WHY TWO WRITES AND NOT A TRANSACTION: the DynamoDB idiom is
   * TransactWriteItems([Put user, Put email claim]), which is atomic.
   * ScyllaDB's Alternator does not implement it (verified:
   * `UnknownOperationException`), so this uses the pre-transaction pattern --
   * claim, write, release the claim if the write fails.
   *
   * The residual risk is a crash in between, leaving an orphan claim that makes
   * that address unusable until someone deletes the row. That is the trade for
   * code that runs unchanged on both Alternator and real DynamoDB. Once you are
   * on AWS only, collapse these into a TransactWriteItems.
   *
   * Returns null when the address is already claimed.
   */
  async create(input: {
    id: string;
    email: string;
    name: string;
    role: UserRole;
  }): Promise<UserRow | null> {
    const now = new Date().toISOString();
    // Lowercased into the key: DynamoDB compares bytes, so without this
    // "A@x.com" and "a@x.com" are two different users.
    const email = input.email.trim().toLowerCase();

    if (!(await this.emails.putIfAbsent({ email, userId: input.id }, "email"))) {
      return null;
    }

    const user: UserRow = {
      id: input.id,
      email,
      name: input.name,
      role: input.role,
      status: "active",
      createdAt: now,
      updatedAt: now,
      listPartition: USER_LIST_PARTITION,
      // The id is a tiebreaker: two users created in the same millisecond would
      // otherwise collide on the sort key.
      listSortKey: `${now}#${input.id}`,
    };

    try {
      await this.users.put(user, { conditionExpression: "attribute_not_exists(id)" });
    } catch (err) {
      // Release the claim rather than leaking it; the address stays usable.
      await this.emails.delete({ email }).catch(() => null);
      throw err;
    }

    return user;
  }

  async update(
    id: string,
    changes: { name?: string; role?: UserRole; status?: UserStatus },
  ): Promise<UserRow | null> {
    const names: Record<string, string> = { "#updatedAt": "updatedAt" };
    const values: Record<string, unknown> = { ":updatedAt": new Date().toISOString() };
    const sets = ["#updatedAt = :updatedAt"];

    // Only the keys actually present are written. Assigning every field would
    // overwrite a real value with undefined on a partial PATCH.
    for (const [field, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      names[`#${field}`] = field;
      values[`:${field}`] = value;
      sets.push(`#${field} = :${field}`);
    }

    return this.users.updateIf({
      key: { id },
      updateExpression: `SET ${sets.join(", ")}`,
      conditionExpression: "attribute_exists(id) AND attribute_not_exists(deletedAt)",
      expressionAttributeNames: names,
      expressionAttributeValues: values,
    });
  }

  /**
   * Soft delete. REMOVEing the two index attributes drops the row out of every
   * list query for free -- that is what a sparse index buys, versus paying to
   * read deleted rows and filter them out afterwards.
   */
  async softDelete(id: string): Promise<UserRow | null> {
    const previous = await this.users.updateIf({
      key: { id },
      updateExpression: "SET deletedAt = :now, updatedAt = :now REMOVE listPartition, listSortKey",
      conditionExpression: "attribute_exists(id) AND attribute_not_exists(deletedAt)",
      expressionAttributeValues: { ":now": new Date().toISOString() },
      returnValues: "ALL_OLD",
    });

    if (!previous) return null;

    // Free the address, matching what a partial unique index would have done.
    await this.emails.delete({ email: previous.email }).catch(() => null);
    return previous;
  }

  /**
   * Newest first, via the sparse list index.
   *
   * `status` is a FilterExpression applied AFTER the index read, so a page can
   * come back shorter than `limit` while more items remain. Callers page until
   * `nextCursor` is absent, never until a page looks short.
   */
  async list(filter: ListUsersFilter): Promise<Page<UserRow>> {
    return this.users.queryPage({
      indexName: "by-created-at",
      keyConditionExpression: "listPartition = :partition",
      expressionAttributeValues: {
        ":partition": USER_LIST_PARTITION,
        ...(filter.status ? { ":status": filter.status } : {}),
      },
      ...(filter.status
        ? {
            filterExpression: "#status = :status",
            expressionAttributeNames: { "#status": "status" },
          }
        : {}),
      // false = descending: the sort key starts with an ISO-8601 timestamp.
      scanIndexForward: false,
      limit: filter.limit,
      cursor: filter.cursor,
    });
  }
}

export const userRepository = new UserRepository();
