/**
 * Vitest globalSetup for the database-backed projects.
 *
 * WHY THIS EXISTS: without it, forgetting `test:db:migrate` produces 22
 * failures all saying `relation "users" does not exist` -- which reads like a
 * broken test suite, not a missing setup step. That happened twice while this
 * repo was being written, to the person writing it. An error message that
 * names the command is worth more than the comment explaining why it is
 * needed.
 *
 * Applies pending migrations automatically, but ONLY against a config whose
 * environment is `test`. A test command must never silently migrate a
 * development or production database.
 *
 * Lives in packages/database rather than scripts/ because Bun does not hoist
 * workspace dependencies to the root: a file under scripts/ cannot resolve
 * `@app/config` at all.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { applicationConfig } from "@app/config";

import { closeORM, initializeORM } from "./orm.ts";

/**
 * Absolute, derived from this file -- NOT the "./migrations" default, which is
 * resolved against process.cwd(). Vitest runs from the repository root, where
 * that path does not exist, so the default silently finds zero migrations and
 * reports nothing pending. Same cwd trap as the tsconfig one in README.md.
 */
const migrationsPath = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");

export async function setup(): Promise<void> {
  if (applicationConfig.application.environment !== "test") {
    throw new Error(
      `Refusing to run the suite against a "${applicationConfig.application.environment}" config.\n` +
        `Run tests via the package scripts, which set APP_CONFIG_PATH=./config/application.test.yml.`,
    );
  }

  let orm;
  try {
    orm = await initializeORM({ databaseUrl: applicationConfig.database.url, migrationsPath });
    await orm.em.getConnection().execute("select 1");
  } catch (err) {
    await closeORM().catch(() => {});
    throw new Error(
      `Cannot reach the test database at ${applicationConfig.database.url}\n` +
        `  ${err instanceof Error ? err.message : String(err)}\n\n` +
        `Start it with:  bun run test:db:up`,
    );
  }

  const migrator = orm.getMigrator();
  const pending = await migrator.getPendingMigrations();

  if (pending.length > 0) {
    console.log(`[preflight] applying ${pending.length} pending migration(s) to the test database`);
    await migrator.up();
  }

  await closeORM();
}
