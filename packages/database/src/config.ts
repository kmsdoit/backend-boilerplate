import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";

import { entities } from "./entities/index.ts";

export interface DatabaseConfigOptions {
  databaseUrl: string;
  pool?: { min: number; max: number };
  /**
   * Postgres `statement_timeout` for every connection, in milliseconds.
   *
   * WHY THIS IS NOT THE SAME AS THE HTTP REQUEST TIMEOUT: aborting an HTTP
   * request stops us *waiting* for the query. It does not stop the query --
   * Postgres keeps executing it, holding its locks and its worker, until it
   * finishes on its own. A slow endpoint under load therefore sheds its
   * clients while the database keeps doing all of the work, which is the
   * shape of an outage that looks fine in application metrics.
   *
   * Set slightly above the HTTP timeout so the application-level error wins
   * in the normal case and this stays the backstop.
   */
  statementTimeoutMs?: number;
  /**
   * How long a request may wait for a free pool connection before failing.
   * Unbounded by default in knex, which turns pool exhaustion into requests
   * that hang forever instead of an error you can see and alert on.
   */
  acquireTimeoutMs?: number;
  migrationsPath?: string;
  migrationsPathTs?: string;
}

/**
 * Builds a MikroORM configuration from explicit arguments and reads no
 * environment variables of its own. That is deliberate: a test can hand this
 * a throwaway database URL without any process-global juggling, and there is
 * exactly one place (backend/src/lib/db.ts) where the real config is read.
 */
export function createMikroOrmConfig({
  databaseUrl,
  pool,
  statementTimeoutMs,
  acquireTimeoutMs = 5_000,
  migrationsPath = "./migrations",
  migrationsPathTs = migrationsPath,
}: DatabaseConfigOptions) {
  return defineConfig({
    clientUrl: databaseUrl,
    entities,
    pool: {
      ...pool,
      acquireTimeoutMillis: acquireTimeoutMs,
      // Runs once per physical connection, not per query, so this costs
      // nothing on the hot path.
      ...(statementTimeoutMs
        ? {
            afterCreate: (
              connection: { query: (sql: string, cb: (err: unknown) => void) => void },
              done: (err: unknown, conn: unknown) => void,
            ) => {
              connection.query(`set statement_timeout = ${statementTimeoutMs}`, (err) =>
                done(err, connection),
              );
            },
          }
        : {}),
    },
    discovery: {
      warnWhenNoEntities: false,
    },
    extensions: [Migrator],
    migrations: {
      path: migrationsPath,
      pathTs: migrationsPathTs,
      glob: "!(*.d).{js,ts}",
      emit: "ts",
    },
  });
}
