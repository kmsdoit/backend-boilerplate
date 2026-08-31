import { Entity, Enum, Index, Property, type Opt } from "@mikro-orm/core";

import { userRoleValues, userStatusValues, type UserRole, type UserStatus } from "@app/contracts";

import { BaseEntity } from "./base.entity.ts";

/**
 * The example entity -- replace it with your own domain.
 *
 * Two patterns here are worth keeping regardless of what replaces `User`:
 *
 * 1. Soft delete (`deletedAt`) rather than a hard DELETE, so a mistaken
 *    deletion is recoverable and foreign keys pointing at the row stay valid.
 * 2. A *partial* unique index for uniqueness that only applies to live rows.
 *    A plain UNIQUE(email) would make an address unusable forever once a user
 *    with it was soft-deleted.
 */
@Entity({ tableName: "users" })
@Index({ name: "users_status_created_at_index", properties: ["status", "createdAt"] })
// TRAP: MikroORM cannot express a partial (WHERE-clause) unique index through
// `properties`, so it is declared here as raw DDL. This decorator does NOT
// create the index -- the migration does. It exists only so `db:generate`'s
// schema diff recognises the index as intentional and stops emitting a
// `drop index` for it on every run.
//
// If you change the columns or the WHERE clause, you must hand-write a
// migration AND update this expression to byte-identical DDL, or the next
// `db:generate` will try to drop and recreate the real index.
// Serves the default list query (`where deleted_at is null order by
// created_at desc, id desc`). Same expression-only declaration as below, for
// the same reason: MikroORM cannot model a partial index from properties.
@Index({
  name: "users_active_created_at_index",
  expression:
    'create index "users_active_created_at_index" on "users" ("created_at" desc, "id" desc) where "deleted_at" is null',
})
@Index({
  name: "users_active_email_unique",
  expression:
    // No trailing semicolon: MikroORM emits this string verbatim into a
    // generated migration, and a trailing ";" there produces `...;;`.
    'create unique index "users_active_email_unique" on "users" ("email") where "deleted_at" is null',
})
export class User extends BaseEntity {
  @Property({ type: "string", length: 255 })
  email!: string;

  @Property({ type: "string", length: 255 })
  name!: string;

  // `& Opt` for the same reason as the BaseEntity timestamps: there is a
  // default, so `em.create()` must not demand a value.
  @Enum({ items: () => [...userRoleValues] })
  role: UserRole & Opt = "member";

  @Enum({ items: () => [...userStatusValues] })
  status: UserStatus & Opt = "active";

  /**
   * Null means live. Every query that should not see deleted rows must filter
   * on this explicitly -- see `createUserRepository`, which is the single
   * place that knows the filter, so no route has to remember it.
   */
  @Property({ type: "timestamptz", nullable: true })
  deletedAt?: Date;
}
