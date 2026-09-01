#!/usr/bin/env bun
/** Creates any missing tables and indexes: `bun run db:provision`. */
import { applicationConfig } from "@app/config";

import { allTables } from "./tables.ts";
import { provisionTables } from "./provisioning.ts";

const created = await provisionTables();
const target = applicationConfig.dynamo.endpoint ?? applicationConfig.dynamo.region;

console.log(
  created.length > 0
    ? `created ${created.join(", ")} on ${target}`
    : `all ${allTables.length} tables already present on ${target}`,
);
