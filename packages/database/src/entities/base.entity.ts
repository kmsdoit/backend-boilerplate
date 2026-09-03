import { Entity, PrimaryKey, Property, type Opt } from "@mikro-orm/core";

/**
 * Every persisted entity extends this. Keeping id/createdAt/updatedAt in one
 * place means a new table cannot accidentally ship without timestamps, which
 * is the kind of thing nobody notices until the first incident where they
 * would have answered the question.
 *
 * `timestamptz`, not `timestamp`: a naive timestamp column silently reads
 * back in whatever timezone the reading session happens to have.
 *
 * The `& Opt` markers tell MikroORM these are optional in `em.create()` input
 * -- they have runtime defaults, so requiring callers to pass them would mean
 * every call site inventing a timestamp the ORM is about to overwrite.
 */
@Entity({ abstract: true })
export abstract class BaseEntity {
  @PrimaryKey({ type: "number" })
  id!: number;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date & Opt = new Date();

  @Property({
    type: "timestamptz",
    onCreate: () => new Date(),
    onUpdate: () => new Date(),
  })
  updatedAt: Date & Opt = new Date();
}
