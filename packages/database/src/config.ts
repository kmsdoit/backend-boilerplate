import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/mysql";

import { entities } from "./entities/index.ts";

export interface DatabaseConfigOptions {
  databaseUrl: string;
  pool?: { min: number; max: number };
  /**
   * MySQL `max_execution_time` for every connection, in milliseconds.
   *
   * WHY THIS IS NOT THE SAME AS THE HTTP REQUEST TIMEOUT: aborting an HTTP
   * request stops us *waiting* for the query. It does not stop the query --
   * the server keeps executing it, holding its locks, until it finishes. A
   * slow endpoint under load therefore sheds its clients while the database
   * keeps doing all of the work, which is the shape of an outage that looks
   * fine in application metrics.
   *
   * LIMITATION, and it is a real downgrade from Postgres: MySQL's
   * `max_execution_time` applies to READ-ONLY SELECTs only. A slow UPDATE or
   * DELETE has no server-side ceiling at all -- measured on 8.4, an UPDATE ran
   * 15.8s against a 500ms setting, untouched, while a row-returning SELECT was
   * cut off at 501ms with ER_QUERY_TIMEOUT. Postgres `statement_timeout`
   * covered every statement; nothing here does. Long writes need a lock-wait
   * timeout and batching instead.
   *
   * Set slightly above the HTTP timeout so the application-level error wins in
   * the normal case and this stays the backstop.
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
              // UTC first, and unconditionally: MySQL's server default is
              // `SYSTEM`, so without this a datetime column reads back in
              // whatever zone the host happens to be in.
              connection.query("set session time_zone = '+00:00'", (tzErr) => {
                if (tzErr) return done(tzErr, connection);
                connection.query(`set session max_execution_time = ${statementTimeoutMs}`, (err) =>
                  done(err, connection),
                );
              });
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
