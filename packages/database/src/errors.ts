/**
 * DynamoDB has no SQLSTATE. A failed uniqueness guard arrives as a named
 * exception from a ConditionExpression, which is what replaces Postgres's
 * `23505` here.
 *
 * Matched on `name`, not `instanceof`, for the same reason the Postgres
 * version matched on `code`: two copies of the AWS SDK on disk mean the class
 * the client throws and the class you imported can be different constructors,
 * and `instanceof` then silently returns false. `name` is a plain string
 * property and survives that.
 */
export function isConditionalCheckFailed(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "ConditionalCheckFailedException"
  );
}

/**
 * Thrown by a repository when a lock item already exists.
 *
 * Uniqueness is enforced by a conditional write on a dedicated lock item, NOT
 * by a constraint the database owns, so the failure has to travel as a domain
 * error rather than being recognised from a driver code at the edge. See
 * `createUserRepository` for the write sequence and what it costs.
 */
export class UniqueConstraintError extends Error {
  constructor(readonly field: string) {
    super(`${field} already in use`);
    this.name = "UniqueConstraintError";
  }
}
