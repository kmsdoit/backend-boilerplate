/**
 * Shared vocabulary: zod schemas, enums, and the types derived from them.
 *
 * This package performs no I/O and depends on no other workspace package, so
 * both the HTTP layer and the persistence layer can import it without either
 * one depending on the other.
 */
export {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  paginationQueryShape,
  type Page,
  type PaginationQuery,
} from "./pagination.ts";

export {
  createUserSchema,
  listUsersQueryShape,
  updateUserSchema,
  userRoleValues,
  userStatusValues,
  type CreateUserInput,
  type UpdateUserInput,
  type UserRole,
  type UserStatus,
} from "./user.ts";

// domain-contracts: `bun run new:domain` inserts above this line.
