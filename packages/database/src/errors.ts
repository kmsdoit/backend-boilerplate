/** Postgres SQLSTATE for unique_violation. */
export const PG_UNIQUE_VIOLATION_CODE = "23505";

/**
 * True for a unique-constraint violation, with the constraint name if
 * Postgres reported one.
 *
 * TRAP -- deliberately NOT `instanceof UniqueConstraintViolationException`.
 * A monorepo routinely ends up with two on-disk copies of @mikro-orm/core
 * (this package's own dependency, plus the one @mikro-orm/postgresql resolves
 * internally). The class the driver throws and the class you imported are
 * then two different constructor functions even at identical versions, and
 * `instanceof` silently returns false -- so the 409 you wrote never fires and
 * the caller gets a 500 instead.
 *
 * `code` and `constraint` are plain properties MikroORM copies off the
 * underlying pg error, so they survive regardless of which copy of the class
 * did the wrapping. Match on those.
 */
export function isUniqueViolation(err: unknown): err is { code: string; constraint?: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION_CODE
  );
}
