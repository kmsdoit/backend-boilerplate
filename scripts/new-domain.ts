#!/usr/bin/env bun
/**
 * Scaffolds one domain across all five layers and wires it in:
 *
 *   bun run new:domain post
 *
 * The point is not typing speed. It is that the layering in this repo only
 * works if every domain follows it -- repository owns the queries, mapper owns
 * what leaves, errors are factories, routes declare schemas. A README asking
 * people to do that by hand is a suggestion; a generator makes it the default.
 *
 * Everything it writes is ordinary code you are expected to edit. There is no
 * runtime framework behind it and nothing regenerates.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const rawName = process.argv[2];
if (!rawName || !/^[a-z][a-z0-9-]*$/.test(rawName)) {
  console.error(
    "usage: bun run new:domain <name>   (lowercase kebab-case, singular -- e.g. post, order-item)",
  );
  process.exit(1);
}

// "order-item" -> OrderItem / orderItem / order-items / order_items
const pascal = rawName.replace(/(^|-)([a-z])/g, (_, __, c: string) => c.toUpperCase());
const camel = pascal.charAt(0).toLowerCase() + pascal.slice(1);
/** Naive plural. Fix it by hand if English disagrees -- it is used for the route path and table name only. */
const plural = `${rawName}s`;
const pluralCamel = `${camel}s`;
const table = plural.replace(/-/g, "_");

function write(relativePath: string, contents: string): void {
  const target = resolve(root, relativePath);
  if (existsSync(target)) {
    console.error(`refusing to overwrite ${relativePath}`);
    process.exit(1);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  console.log(`  created  ${relativePath}`);
}

/** Adds names to keys.ts's single re-export line in packages/database/src/index.ts. */
function appendToKeysExport(names: string[]): void {
  const target = resolve(root, "packages/database/src/index.ts");
  const source = readFileSync(target, "utf8");
  const updated = source.replace(
    /export \{([^}]*)\} from "\.\/keys\.ts";/,
    (_match, existing: string) => {
      const merged = [
        ...existing
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean),
        ...names.filter((name) => !existing.includes(name)),
      ];
      return `export { ${merged.join(", ")} } from "./keys.ts";`;
    },
  );
  if (updated !== source) {
    writeFileSync(target, updated);
    console.log("  wired    packages/database/src/index.ts");
  }
}

/** Inserts `line` immediately above the anchor comment, keeping the anchor last. */
function wire(relativePath: string, anchor: string, line: string): void {
  const target = resolve(root, relativePath);
  if (!existsSync(target)) {
    // Warn and continue. A generator that dies halfway leaves the tree in a
    // state that is worse than either doing nothing or finishing.
    console.error(`  skipped  ${relativePath} (missing) -- wire "${anchor}" by hand`);
    return;
  }
  const source = readFileSync(target, "utf8");
  const marker = source.split("\n").find((l) => l.includes(`${anchor}:`));
  if (!marker) {
    console.error(`anchor "${anchor}" not found in ${relativePath} -- wire it by hand`);
    return;
  }
  if (source.includes(line.trim())) {
    return;
  }
  writeFileSync(target, source.replace(marker, `${line}\n${marker}`));
  console.log(`  wired    ${relativePath}`);
}

write(
  `packages/contracts/src/${rawName}.ts`,
  `import { z } from "zod";

/** What a request may contain. No I/O, no database types -- see packages/contracts/src/user.ts. */
export const create${pascal}Schema = z.strictObject({
  name: z.string().min(1).max(255),
});
export type Create${pascal}Input = z.infer<typeof create${pascal}Schema>;

/**
 * Every field optional; an absent key means "this PATCH did not touch it",
 * never "clear it". \`.strictObject\` so a typo'd field is a 400 rather than a
 * silently ignored no-op, and \`.refine\` so an empty body is rejected.
 */
export const update${pascal}Schema = z
  .strictObject({
    name: z.string().min(1).max(255).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one field must be provided",
  });
export type Update${pascal}Input = z.infer<typeof update${pascal}Schema>;

/**
 * No free-text search parameter, deliberately: DynamoDB cannot serve one
 * without a full table Scan. See "Searching" in README.md for what to do
 * instead.
 */
`,
);

const UPPER = rawName.replace(/-/g, "_").toUpperCase();

// Key helpers go into the shared keys.ts rather than a file per domain: the
// whole point of that file is that the table's key layout can be read in one
// screen.
wire(
  "packages/database/src/keys.ts",
  "domain-keys",
  `// domain:${rawName}
/** ${pascal}: pk = ${UPPER}#<id>; listed newest-first via gsi1. */
export const ${UPPER}_LIST_PARTITION = "${UPPER}";
export const ${camel}Key = (id: string) => \`${UPPER}#\${id}\`;
// /domain:${rawName}
`,
);
// One re-export line for every domain's key helpers, rewritten in place.
appendToKeysExport([`${UPPER}_LIST_PARTITION`, `${camel}Key`]);

write(
  `backend/src/${rawName}/${rawName}-repository.ts`,
  `import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import type { Page, PaginationQuery } from "@app/contracts";
import {
  GSI1,
  ${UPPER}_LIST_PARTITION,
  ${camel}Key,
  decodeCursor,
  doc,
  encodeCursor,
  isConditionalCheckFailed,
  listSortKey,
  tableName,
} from "@app/database";

export type ${pascal}Record = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

type ${pascal}Item = ${pascal}Record & { pk: string; gsi1pk?: string; gsi1sk?: string };

/** All access to ${plural}, in one place, so the key layout stays readable. */
export function create${pascal}Repository() {
  async function findById(id: string): Promise<${pascal}Record | null> {
    const result = await doc.send(new GetCommand({ TableName: tableName, Key: { pk: ${camel}Key(id) } }));
    const item = result.Item as ${pascal}Item | undefined;
    // A soft-deleted item is still addressable by key -- only the index drops it.
    if (!item || item.deletedAt) {
      return null;
    }
    return toRecord(item);
  }

  async function create(input: { id: string; name: string }): Promise<${pascal}Record> {
    const now = new Date().toISOString();
    const item: ${pascal}Item = {
      pk: ${camel}Key(input.id),
      id: input.id,
      name: input.name,
      createdAt: now,
      updatedAt: now,
      // Presence of these two is what puts the item in the list index.
      gsi1pk: ${UPPER}_LIST_PARTITION,
      gsi1sk: listSortKey(now, input.id),
    };

    await doc.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );

    return toRecord(item);
  }

  async function update(id: string, changes: { name?: string }): Promise<${pascal}Record | null> {
    const names: Record<string, string> = { "#updatedAt": "updatedAt" };
    const values: Record<string, unknown> = { ":updatedAt": new Date().toISOString() };
    const sets = ["#updatedAt = :updatedAt"];

    // Only the keys actually present are written; assigning every field would
    // overwrite a real value with undefined on a partial PATCH.
    for (const [field, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      names[\`#\${field}\`] = field;
      values[\`:\${field}\`] = value;
      sets.push(\`#\${field} = :\${field}\`);
    }

    try {
      const result = await doc.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: ${camel}Key(id) },
          UpdateExpression: \`SET \${sets.join(", ")}\`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          // UpdateItem is an upsert by default: without this a PATCH to a
          // deleted id would silently resurrect it as a blank item.
          ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(deletedAt)",
          ReturnValues: "ALL_NEW",
        }),
      );
      return toRecord(result.Attributes as ${pascal}Item);
    } catch (err) {
      if (isConditionalCheckFailed(err)) return null;
      throw err;
    }
  }

  /**
   * Soft delete. REMOVEing the index attributes drops the item out of every
   * list query for free -- that is what a sparse GSI buys, versus paying to
   * read deleted items and filter them out afterwards.
   */
  async function softDelete(id: string): Promise<${pascal}Record | null> {
    const now = new Date().toISOString();
    try {
      const result = await doc.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: ${camel}Key(id) },
          UpdateExpression: "SET deletedAt = :now, updatedAt = :now REMOVE gsi1pk, gsi1sk",
          ExpressionAttributeValues: { ":now": now },
          ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(deletedAt)",
          ReturnValues: "ALL_OLD",
        }),
      );
      return toRecord(result.Attributes as ${pascal}Item);
    } catch (err) {
      if (isConditionalCheckFailed(err)) return null;
      throw err;
    }
  }

  async function list(filter: PaginationQuery): Promise<Page<${pascal}Record>> {
    const result = await doc.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: GSI1,
        KeyConditionExpression: "gsi1pk = :partition",
        ExpressionAttributeValues: { ":partition": ${UPPER}_LIST_PARTITION },
        // false = descending, i.e. newest first, because gsi1sk starts with an
        // ISO-8601 timestamp.
        ScanIndexForward: false,
        Limit: filter.limit,
        ExclusiveStartKey: decodeCursor(filter.cursor),
      }),
    );

    return {
      items: ((result.Items ?? []) as ${pascal}Item[]).map(toRecord),
      nextCursor: encodeCursor(result.LastEvaluatedKey),
    };
  }

  return { findById, create, update, softDelete, list };
}

/** Strips the key attributes; nothing above this layer should see them. */
function toRecord(item: ${pascal}Item): ${pascal}Record {
  const { pk: _pk, gsi1pk: _g1, gsi1sk: _g2, ...record } = item;
  return record;
}

export type ${pascal}Repository = ReturnType<typeof create${pascal}Repository>;
`,
);

write(
  `backend/src/${rawName}/${rawName}-response.ts`,
  `import type { ${pascal}Record } from "./${rawName}-repository.ts";

export type ${pascal}Response = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * The one place a ${pascal} becomes a response body.
 *
 * It matters more here than with a relational mapper: a DynamoDB item is a bag
 * of attributes, so \`pk\`, \`gsi1pk\`, \`gsi1sk\` and \`deletedAt\` would all be
 * serialised straight to the client by an accidental \`c.json(item)\`. Listing
 * fields explicitly is what stops key layout from becoming public API.
 */
export function to${pascal}Response(${camel}: ${pascal}Record): ${pascal}Response {
  return {
    id: ${camel}.id,
    name: ${camel}.name,
    createdAt: ${camel}.createdAt,
    updatedAt: ${camel}.updatedAt,
  };
}
`,
);

write(
  `backend/src/api/routes/${rawName}.ts`,
  `import { create${pascal}Schema, paginationQueryShape, update${pascal}Schema } from "@app/contracts";

import { route, routes } from "../../lib/app-context.ts";
import { create${pascal}Repository } from "../../${rawName}/${rawName}-repository.ts";
import { to${pascal}Response } from "../../${rawName}/${rawName}-response.ts";
import { ${pascal}NotFound } from "./errors.ts";

const ${pluralCamel} = create${pascal}Repository();

export const ${camel}Routes = routes(
  route("/${plural}", "GET", {
    query: paginationQueryShape,
    handler: async ({ query, c }) => {
      const page = await ${pluralCamel}.list(query);

      // No \`total\`: counting means reading every matching item. The absence of
      // \`nextCursor\` is the only "you have reached the end" signal.
      return c.json(
        { items: page.items.map(to${pascal}Response), nextCursor: page.nextCursor ?? null },
        200,
      );
    },
  }),

  route("/${plural}/:id", "GET", {
    handler: async ({ params, c }) => {
      const found = await ${pluralCamel}.findById(params.id);
      if (!found) throw ${pascal}NotFound();
      return c.json(to${pascal}Response(found), 200);
    },
  }),

  route("/${plural}", "POST", {
    body: create${pascal}Schema,
    handler: async ({ body, c }) => {
      // The id is generated here, not by the store: DynamoDB has no sequences,
      // and a client-chosen key is what lets the write be a single conditional
      // Put instead of a read-then-write.
      const created = await ${pluralCamel}.create({ id: crypto.randomUUID(), ...body });
      return c.json(to${pascal}Response(created), 201);
    },
  }),

  route("/${plural}/:id", "PATCH", {
    body: update${pascal}Schema,
    handler: async ({ params, body, c }) => {
      const updated = await ${pluralCamel}.update(params.id, body);
      if (!updated) throw ${pascal}NotFound();
      return c.json(to${pascal}Response(updated), 200);
    },
  }),

  route("/${plural}/:id", "DELETE", {
    handler: async ({ params, c }) => {
      const deleted = await ${pluralCamel}.softDelete(params.id);
      if (!deleted) throw ${pascal}NotFound();
      return c.body(null, 204);
    },
  }),
);
`,
);

wire(
  "packages/contracts/src/index.ts",
  "domain-contracts",
  `export {
  create${pascal}Schema,
  update${pascal}Schema,
  type Create${pascal}Input,
  type Update${pascal}Input,
} from "./${rawName}.ts";`,
);
wire(
  "backend/src/api/routes/index.ts",
  "domain-imports",
  `import { ${camel}Routes } from "./${rawName}.ts";`,
);
wire("backend/src/api/routes/index.ts", "domain-routes", `  ...${camel}Routes.routes,`);

// Error factories are appended rather than anchored: this file is meant to be
// read top to bottom as the API's whole error vocabulary.
const errorsPath = resolve(root, "backend/src/api/routes/errors.ts");
const errorsSource = readFileSync(errorsPath, "utf8");
if (!errorsSource.includes(`${pascal}NotFound`)) {
  writeFileSync(
    errorsPath,
    `${errorsSource}\nexport const ${pascal}NotFound = () =>\n  new HTTPException(404, { message: "${rawName.replace(/-/g, " ")} not found" });\n`,
  );
  console.log("  wired    backend/src/api/routes/errors.ts");
}

console.log(`
Next:
  bun run dev               # GET/POST /${plural}

There is no migration step: DynamoDB has no schema, and this domain shares the
existing table. Adding an ACCESS PATTERN is the change that costs -- it means a
new index, which means editing packages/database/src/table.ts.
`);
