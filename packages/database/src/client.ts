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
 */
const { endpoint, region, accessKeyId, secretAccessKey, tableNamePrefix } =
  applicationConfig.dynamo;

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
 * and from DynamoDB's `{"S": "..."}` attribute-value shape.
 */
export const doc = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    // A property set to undefined means "no value", not "store a null".
    removeUndefinedValues: true,
    convertClassInstanceToMap: false,
  },
});

export const rawClient = client;

/**
 * Physical table name for a logical entity.
 *
 * The prefix is what lets dev, test and production share an AWS account
 * without colliding, and it is why the test config can point at its own set of
 * tables on the same node.
 */
export const tableNameFor = (entity: string) => `${tableNamePrefix}-${entity}`;
