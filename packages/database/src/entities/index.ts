import { User } from "./user.ts";
// domain-imports: `bun run new:domain` inserts above this line.

/**
 * Register every concrete entity here. This explicit list -- rather than a
 * filesystem glob -- is what lets the application build an ORM config without
 * knowing anything about where the files live on disk, which in turn is what
 * makes the Docker image work (a glob resolved relative to a cwd that differs
 * between local dev and the container is a classic silent failure).
 */
export const entities = [
  User,
  // domain-entities: `bun run new:domain` inserts above this line.
];

export { BaseEntity } from "./base.entity.ts";
export { User } from "./user.ts";
// domain-exports: `bun run new:domain` inserts above this line.
