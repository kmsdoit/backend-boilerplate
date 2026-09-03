import { Migration } from "@mikro-orm/migrations";

/**
 * Initial schema.
 *
 * Hand-written rather than generated, because the partial unique index below
 * is something `db:generate` cannot produce from the entity definitions --
 * see the TRAP comment on the matching @Index decorator in
 * src/entities/user.ts. Read every generated migration before committing it
 * for the same reason: the diff engine cannot see the index and will happily
 * emit a `drop index` for it.
 */
export class Migration20260101000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "users" (
        "id" serial primary key,
        "created_at" timestamptz not null,
        "updated_at" timestamptz not null,
        "email" varchar(255) not null,
        "name" varchar(255) not null,
        "role" text check ("role" in ('admin', 'member')) not null default 'member',
        "status" text check ("status" in ('active', 'suspended')) not null default 'active',
        "deleted_at" timestamptz null
      );
    `);

    // Uniqueness that applies to live rows only. A plain UNIQUE(email) would
    // make an address permanently unusable after the user holding it is
    // soft-deleted.
    this.addSql(`
      create unique index "users_active_email_unique"
        on "users" ("email") where "deleted_at" is null;
    `);

    // Supports the default list query: filter by status, order by created_at.
    this.addSql(`
      create index "users_status_created_at_index" on "users" ("status", "created_at");
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "users" cascade;`);
  }
}
