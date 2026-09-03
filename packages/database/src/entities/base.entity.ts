import { Entity, PrimaryKey, Property, type Opt } from "@mikro-orm/core";

/**
 * Every persisted entity extends this. Keeping id/createdAt/updatedAt in one
 * place means a new table cannot accidentally ship without timestamps, which
 * is the kind of thing nobody notices until the first incident where they
 * would have answered the question.
 *
 * MySQL has no `timestamptz`. `datetime(3)` stores exactly what it is given,
 * so correctness depends on every connection agreeing on the zone -- which is
 * why `createMikroOrmConfig` forces `time_zone = '+00:00'` on each one. Without
 * that the server default is `SYSTEM`, and the same row reads back differently
 * depending on the host's timezone (verified: a fresh mysql:8.4 reports
 * `@@session.time_zone = SYSTEM`).
 *
 * The `(3)` keeps milliseconds. MySQL's default precision is 0 -- whole
 * seconds -- which quietly makes `createdAt` a poor tiebreaker.
 *
 * The `& Opt` markers tell MikroORM these are optional in `em.create()` input
 * -- they have runtime defaults, so requiring callers to pass them would mean
 * every call site inventing a timestamp the ORM is about to overwrite.
 */
@Entity({ abstract: true })
export abstract class BaseEntity {
  @PrimaryKey({ type: "number" })
  id!: number;

  @Property({ type: "datetime", length: 3, onCreate: () => new Date() })
  createdAt: Date & Opt = new Date();

  @Property({
    type: "datetime",
    length: 3,
    onCreate: () => new Date(),
    onUpdate: () => new Date(),
  })
  updatedAt: Date & Opt = new Date();
}
