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
 * 2. Uniqueness that applies to live rows only. A plain UNIQUE(email) would
 *    make an address unusable forever once its owner was soft-deleted.
 */
@Entity({ tableName: "users" })
@Index({ name: "users_status_created_at_index", properties: ["status", "createdAt"] })
// Serves the default list query (`where deleted_at is null order by created_at
// desc, id desc`). MEASURED value: the unfiltered list was a full scan before
// an index matching this shape existed. Unlike the Postgres original this
// cannot be partial -- see emailActive below -- so it also indexes
// soft-deleted rows, which costs a little space and nothing in correctness.
@Index({ name: "users_created_at_index", properties: ["createdAt", "id"] })
export class User extends BaseEntity {
  @Property({ type: "string", length: 255 })
  email!: string;

  /**
   * TRAP -- this column is the whole reason the soft-delete story works on
   * MySQL, and it is not obvious.
   *
   * The Postgres original used a PARTIAL unique index:
   *   create unique index ... on users (email) where deleted_at is null
   * MySQL has no partial indexes at all -- a `WHERE` clause there is a syntax
   * error (verified on 8.4).
   *
   * The MySQL idiom is this generated column: it holds `email` while the row
   * is live and NULL once it is soft-deleted. A UNIQUE index treats every NULL
   * as distinct, so live addresses collide and deleted ones do not -- exactly
   * the behaviour the partial index gave, verified end to end.
   *
   * It is `STORED`, not `VIRTUAL`, because MySQL cannot build a UNIQUE index
   * over a virtual column. Nothing reads this column; do not map it into a
   * response.
   */
  @Property({
    type: "string",
    length: 255,
    nullable: true,
    generated: "always as (if(`deleted_at` is null, `email`, null)) stored",
  })
  emailActive?: string;

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
  @Property({ type: "datetime", length: 3, nullable: true })
  deletedAt?: Date;
}
