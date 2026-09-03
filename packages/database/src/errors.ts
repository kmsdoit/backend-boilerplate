/** MySQL error number for a duplicate key (ER_DUP_ENTRY). */
export const MYSQL_DUPLICATE_ENTRY_ERRNO = 1062;

/**
 * True for a unique-constraint violation.
 *
 * TRAP -- deliberately NOT `instanceof UniqueConstraintViolationException`.
 * A monorepo routinely ends up with two on-disk copies of @mikro-orm/core, so
 * the class the driver throws and the class you imported are different
 * constructor functions even at identical versions, and `instanceof` silently
 * returns false. `errno` is a plain property mysql2 sets and MikroORM copies
 * off the underlying error, so it survives regardless of which copy wrapped it.
 */
export function isUniqueViolation(err: unknown): err is { errno: number; message: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { errno?: unknown }).errno === MYSQL_DUPLICATE_ENTRY_ERRNO
  );
}

/**
 * The index name a duplicate-key error was raised for.
 *
 * MySQL does NOT expose it as a field the way Postgres exposes `constraint`.
 * The only place it appears is inside the message:
 *
 *   Duplicate entry 'a@x.com' for key 'users.users_active_email_unique'
 *
 * so it has to be parsed out. The table qualifier is optional because MySQL 5.7
 * omitted it and 8.0 added it -- matching both keeps this working across
 * versions. Returns undefined rather than throwing on an unrecognised message,
 * so an unmapped constraint degrades to a 500 with the real error logged
 * instead of a parse failure masking it.
 */
export function uniqueViolationIndexName(err: { message: string }): string | undefined {
  return /for key '(?:[^'.]*\.)?([^']+)'/.exec(err.message)?.[1];
}
