import { DdbTable, type TableDefinition } from "./table.ts";

/**
 * Every table this service owns.
 *
 * The definition drives BOTH the typed handle and `provisionTables()`, so the
 * CreateTable call and the access code cannot drift -- a real hazard when the
 * infrastructure declaration lives somewhere else entirely.
 *
 * Row types are plain TypeScript that mirror the item one-to-one. There is no
 * entity class, no decorator and no codegen, because there is no schema to
 * generate from: what the item contains is whatever you wrote to it.
 */

export type UserRow = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
  status: "active" | "suspended";
  /** ISO-8601. Sorts lexicographically, which is what makes it usable as a sort key. */
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  /**
   * Sparse index attributes. An item is in `by-created-at` only while these are
   * present, so soft delete REMOVEs them and the row leaves every list query
   * with no FilterExpression and no wasted reads.
   */
  listPartition?: string;
  listSortKey?: string;
};

/** Claims an email address. A row existing IS the claim; there are no other attributes worth reading. */
export type UserEmailRow = {
  email: string;
  userId: string;
};
export const USER_LIST_PARTITION = "user";

const userTableDefinition: TableDefinition = {
  entity: "users",
  partitionKey: "id",
  indexes: [{ name: "by-created-at", partitionKey: "listPartition", sortKey: "listSortKey" }],
};

const userEmailTableDefinition: TableDefinition = {
  entity: "user-emails",
  partitionKey: "email",
};

/**
 * The handles repositories compose. `TKey` is the real primary-key shape, so
 * passing the wrong key -- or half of a composite one -- is a compile error
 * rather than a runtime ValidationException.
 */
export const tables = {
  users: new DdbTable<UserRow, { id: string }>(userTableDefinition),
  userEmails: new DdbTable<UserEmailRow, { email: string }>(userEmailTableDefinition),
  // domain-tables: `bun run new:domain` inserts above this line.
};

export const allTables = Object.values(tables) as DdbTable<unknown, never>[];
