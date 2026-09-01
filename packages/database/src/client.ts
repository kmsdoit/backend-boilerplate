import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { applicationConfig } from "@app/config";

/**
 * One client per process, built once.
 *
 * The SDK client is cheap to hold and expensive to rebuild: it caches
 * credential resolution and keeps HTTP connections alive. In Lambda this is
 * what makes a warm invocation fast, so it must live at module scope, outside
 * any handler.
 *
 * Nothing here is DynamoDB-specific beyond the endpoint. Point `dynamo.endpoint`
 * at ScyllaDB's Alternator locally, drop it in AWS, and this file does not
 * change -- that portability is the reason the stack was chosen.
 */
const { endpoint, region, accessKeyId, secretAccessKey } = applicationConfig.dynamo;

const client = new DynamoDBClient({
  region,
  ...(endpoint ? { endpoint } : {}),
  // Only for Alternator, which ignores credentials but still needs the SDK to
  // sign. In AWS both are absent and the default provider chain (task role,
  // instance role, SSO) takes over.
  ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
});

/**
 * The Document client, not the raw one: it marshals plain JavaScript values to
 * and from DynamoDB's `{"S": "..."}` attribute-value shape. Using the raw
 * client means writing that shape by hand at every call site.
 */
export const doc = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    // A property set to undefined means "no value", not "store a null".
    removeUndefinedValues: true,
  },
});

export const rawClient = client;
export const tableName = applicationConfig.dynamo.tableName;
