import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";

import { applicationConfig } from "@app/config";

/**
 * Config for the MikroORM *CLI* only (`db:generate`, `db:migrate`, ...).
 * The application itself never reads this file -- it goes through
 * `createMikroOrmConfig` in src/config.ts, which takes the database URL as an
 * argument instead of reaching for global config. Keeping the two separate is
 * what lets a test point the ORM at a throwaway database without also having
 * to satisfy the CLI's file-glob-based entity discovery.
 */
export default defineConfig({
  clientUrl: applicationConfig.database.url,
  entities: ["./dist/entities/*.js"],
  entitiesTs: ["./src/entities/*.ts"],
  extensions: [Migrator],
  migrations: {
    path: "./migrations",
    pathTs: "./migrations",
    glob: "!(*.d).{js,ts}",
    emit: "ts",
  },
});
