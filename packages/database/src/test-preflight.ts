/**
 * Vitest globalSetup for the database-backed projects.
 *
 * WHY THIS EXISTS: without it, forgetting to provision produces a wall of
 * `ResourceNotFoundException` failures that read like a broken suite rather
 * than a missing setup step.
 *
 * Provisions automatically, but ONLY against a config whose environment is
 * `test`. A test command must never create or touch development or production
 * tables.
 */
import { applicationConfig } from "@app/config";

import { provisionTables } from "./provisioning.ts";

export async function setup(): Promise<void> {
  if (applicationConfig.application.environment !== "test") {
    throw new Error(
      `Refusing to run the suite against a "${applicationConfig.application.environment}" config.\n` +
        `Run tests via the package scripts, which set APP_CONFIG_PATH=./config/application.test.yml.`,
    );
  }

  const target = applicationConfig.dynamo.endpoint ?? applicationConfig.dynamo.region;

  try {
    const created = await provisionTables();
    if (created.length > 0) {
      console.log(`[preflight] created ${created.join(", ")}`);
    }
  } catch (err) {
    throw new Error(
      `Cannot reach the test database at ${target}\n` +
        `  ${err instanceof Error ? err.message : String(err)}\n\n` +
        `Start it with:  bun run test:db:up`,
    );
  }
}
