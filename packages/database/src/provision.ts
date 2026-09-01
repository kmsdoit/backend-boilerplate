#!/usr/bin/env bun
/** Creates the table and its index if absent: `bun run db:provision`. */
import { applicationConfig } from "@app/config";

import { tableName } from "./client.ts";
import { provisionTable } from "./table.ts";

const result = await provisionTable();
console.log(
  `table "${tableName}" ${result} (${applicationConfig.dynamo.endpoint ?? applicationConfig.dynamo.region})`,
);
