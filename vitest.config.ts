import { defineConfig } from "vitest/config";

/**
 * One project per workspace package, so a run can be narrowed to what you are
 * actually working on:
 *
 *   APP_CONFIG_PATH=./config/application.test.yml bunx vitest run --project backend
 *
 * `config`, `contracts` and `observability` are pure unit tests. `database`
 * and `backend` talk to the test Postgres and need `bun run test:db:up`
 * first -- the split is what lets CI run the fast half on every push.
 *
 * TRAP: adding a workspace package means adding it here too. A project that
 * is missing from this list is silently never run, and its tests look green
 * because nothing reports on them.
 */
export default defineConfig({
  test: {
    /**
     * TRAP -- do not remove without reading this.
     *
     * The `database` and `backend` projects share ONE test database, and both
     * truncate `users` in a beforeEach. Run in parallel, one project's
     * truncate lands in the middle of the other's test and the failure looks
     * like a query bug ("expected 1 row, got 0") in code that is perfectly
     * correct. Serialising files is the cheap fix.
     *
     * The other fix -- a separate database per project -- is worth doing once
     * the suite is slow enough to care. Serialising is not free, but a fast
     * suite that fails at random is worth less than a slower one you trust.
     */
    fileParallelism: false,
    projects: [
      { test: { name: "config", include: ["packages/config/**/*.test.ts"], environment: "node" } },
      {
        test: {
          name: "contracts",
          include: ["packages/contracts/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "observability",
          include: ["packages/observability/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "database",
          include: ["packages/database/**/*.test.ts"],
          environment: "node",
          // Turns "relation does not exist" x22 into one sentence naming the
          // command you forgot. See packages/database/src/test-preflight.ts.
          globalSetup: ["./packages/database/src/test-preflight.ts"],
        },
      },
      {
        test: {
          name: "backend",
          include: ["backend/**/*.test.ts"],
          environment: "node",
          globalSetup: ["./packages/database/src/test-preflight.ts"],
        },
      },
    ],
  },
});
