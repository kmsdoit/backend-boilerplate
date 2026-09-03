import { MikroORM } from "@mikro-orm/mysql";

import { createMikroOrmConfig, type DatabaseConfigOptions } from "./config.ts";

let orm: MikroORM | undefined;
let initializedDatabaseUrl: string | undefined;

/**
 * One MikroORM instance -- and therefore one connection pool -- per process.
 *
 * Throws rather than silently reusing the existing instance if a second
 * caller asks for a different database URL. Silently returning the first
 * connection is how a test suite ends up writing to the development database
 * and nobody notices until the data is gone.
 */
export async function initializeORM(options: DatabaseConfigOptions): Promise<MikroORM> {
  if (!orm) {
    orm = await MikroORM.init(createMikroOrmConfig(options));
    initializedDatabaseUrl = options.databaseUrl;
  } else if (initializedDatabaseUrl !== options.databaseUrl) {
    throw new Error("MikroORM has already been initialized with a different database URL.");
  }

  return orm;
}

/**
 * A forked EntityManager, which is what request or job code must use.
 *
 * MikroORM's identity map is per-EntityManager. Sharing the root `em` across
 * concurrent requests means request A can see request B's unflushed changes
 * and vice versa; forking gives each unit of work its own clean map.
 */
export async function getEntityManager(options: DatabaseConfigOptions) {
  const initializedOrm = await initializeORM(options);
  return initializedOrm.em.fork();
}

/** Closes the connection pool. Call on shutdown so in-flight queries drain. */
export async function closeORM(): Promise<void> {
  if (orm) {
    await orm.close();
    orm = undefined;
    initializedDatabaseUrl = undefined;
  }
}
