import { Migration } from "@mikro-orm/migrations";

/**
 * Initial schema.
 *
 * Hand-written rather than generated, because the generated column below is
 * the load-bearing piece and deserves to be read rather than diffed into
 * existence. Read every generated migration for the same reason.
 */
export class Migration20260101000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table \`users\` (
        \`id\` int unsigned not null auto_increment primary key,
        \`created_at\` datetime(3) not null,
        \`updated_at\` datetime(3) not null,
        \`email\` varchar(255) not null,
        \`name\` varchar(255) not null,
        \`role\` enum('admin', 'member') not null default 'member',
        \`status\` enum('active', 'suspended') not null default 'active',
        \`deleted_at\` datetime(3) null,
        -- Holds the address while the row is live, NULL once soft-deleted.
        -- MySQL has no partial indexes, and a UNIQUE index treats every NULL as
        -- distinct, so this reproduces "unique among live rows" exactly.
        -- STORED because MySQL cannot index a VIRTUAL column uniquely.
        \`email_active\` varchar(255)
          generated always as (if(\`deleted_at\` is null, \`email\`, null)) stored
      ) default character set utf8mb4 engine = InnoDB;
    `);

    this.addSql(`
      alter table \`users\`
        add unique \`users_active_email_unique\` (\`email_active\`);
    `);

    // Supports filtering by status; ordering still needs the index below.
    this.addSql(`
      alter table \`users\`
        add index \`users_status_created_at_index\` (\`status\`, \`created_at\`);
    `);

    // Serves the default list query. Cannot exclude soft-deleted rows the way
    // the Postgres original did -- no partial indexes -- so it covers them too.
    this.addSql(`
      alter table \`users\`
        add index \`users_created_at_index\` (\`created_at\`, \`id\`);
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists \`users\`;`);
  }
}
