export { createMikroOrmConfig, type DatabaseConfigOptions } from "./config.ts";
export { BaseEntity, User, entities } from "./entities/index.ts";
// domain-entity-exports: `bun run new:domain` inserts above this line.
export { closeORM, getEntityManager, initializeORM } from "./orm.ts";
export {
  isUniqueViolation,
  uniqueViolationIndexName,
  MYSQL_DUPLICATE_ENTRY_ERRNO,
} from "./errors.ts";
/** Re-exported so consumers do not need their own MikroORM dependency. */
export type { EntityManager, FilterQuery } from "@mikro-orm/mysql";
