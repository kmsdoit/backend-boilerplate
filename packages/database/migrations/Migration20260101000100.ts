import { Migration } from "@mikro-orm/migrations";

/**
 * Index for the default list query.
 *
 * MEASURED on 200k rows, before this migration:
 *   GET /users            -> Seq Scan, 200k rows read and sorted, 12.2ms
 *   GET /users?status=... -> Index Scan on (status, created_at),      0.034ms
 *
 * The unfiltered list -- by far the most common call -- was the one request
 * with no usable index, because `users_status_created_at_index` is only
 * reachable when `status` is supplied. This index matches the query the
 * repository actually emits: `where deleted_at is null order by created_at
 * desc, id desc`. After it: 0.027ms.
 *
 * The lesson generalises past this table: index the query your repository
 * emits, not the columns you happen to filter on. Check with
 * `explain (analyze)` before assuming.
 */
export class Migration20260101000100 extends Migration {
  override async up(): Promise<void> {
    // NOTE: plain CREATE INDEX takes an ACCESS EXCLUSIVE lock and blocks all
    // writes for the duration. Fine here (the table is empty at this point in
    // the migration history), an outage on a populated production table --
    // use CREATE INDEX CONCURRENTLY there, which cannot run inside a
    // transaction. See "Operating this" in README.md.
    this.addSql(`
      create index "users_active_created_at_index"
        on "users" ("created_at" desc, "id" desc) where "deleted_at" is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "users_active_created_at_index";`);
  }
}
