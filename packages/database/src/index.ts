export { doc, rawClient, tableName } from "./client.ts";
export { GSI1, listSortKey, USER_LIST_PARTITION, userKey, emailKey } from "./keys.ts";
export { provisionTable, tableExists } from "./table.ts";
export { isConditionalCheckFailed, UniqueConstraintError } from "./errors.ts";
export { decodeCursor, encodeCursor } from "./cursor.ts";
/** Re-exported so consumers do not need their own AWS SDK dependency. */
export type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
