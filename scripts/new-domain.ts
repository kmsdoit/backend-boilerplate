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
/** SCREAMING_SNAKE, for the exported list-partition constant. */
const UPPER = rawName.replace(/-/g, "_").toUpperCase();

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

/**
 * Inserts a domain's row type and table definition above the `tables` object.
 *
 * Appended rather than anchored because the block is multi-line and belongs
 * next to the other row types: tables.ts is meant to be read top to bottom as
 * the whole persistence model.
 */
function appendToTables(block: string): void {
  const target = resolve(root, "packages/database/src/tables.ts");
  const source = readFileSync(target, "utf8");
  const anchor = "/**\n * The handles repositories compose.";
  if (!source.includes(anchor)) {
    console.error("  skipped  packages/database/src/tables.ts -- add the row type by hand");
    return;
  }
  writeFileSync(target, source.replace(anchor, `${block}\n${anchor}`));
  console.log("  wired    packages/database/src/tables.ts (row type)");
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

// Row type + table definition + handle, all from one declaration, so the
// CreateTable call and the access code cannot drift.
wire(
  "packages/database/src/tables.ts",
  "domain-tables",
  `  ${pluralCamel}: new DdbTable<${pascal}Row, { id: string }>(${camel}TableDefinition),`,
);
appendToTables(`
export type ${pascal}Row = {
  id: string;
  name: string;
  /** ISO-8601. Sorts lexicographically, which is what makes it usable as a sort key. */
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  /**
   * Sparse index attributes. An item is in \`by-created-at\` only while these
   * are present, so soft delete REMOVEs them and the row leaves every list
   * query with no FilterExpression and no wasted reads.
   */
  listPartition?: string;
  listSortKey?: string;
};

/** The one partition every live ${rawName} is listed under. */
export const ${UPPER}_LIST_PARTITION = "${rawName}";

const ${camel}TableDefinition: TableDefinition = {
  entity: "${plural}",
  partitionKey: "id",
  indexes: [{ name: "by-created-at", partitionKey: "listPartition", sortKey: "listSortKey" }],
};
`);

write(
  `backend/src/${rawName}/${rawName}-repository.ts`,
  `import type { PaginationQuery } from "@app/contracts";
import { ${UPPER}_LIST_PARTITION, tables, type Page, type ${pascal}Row } from "@app/database";

/**
 * All access to ${plural}. Notice there is not a single DynamoDB command in
 * this file: DdbTable owns command construction, the casts, and the
 * ConditionalCheckFailed translation, so a repository reads as domain logic.
 */
export class ${pascal}Repository {
  constructor(private readonly ${pluralCamel} = tables.${pluralCamel}) {}

  async findById(id: string): Promise<${pascal}Row | null> {
    const found = await this.${pluralCamel}.get({ id });
    // A soft-deleted row is still addressable by key -- only the index drops it.
    return found && !found.deletedAt ? found : null;
  }

  async create(input: { id: string; name: string }): Promise<${pascal}Row> {
    const now = new Date().toISOString();
    const row: ${pascal}Row = {
      id: input.id,
      name: input.name,
      createdAt: now,
      updatedAt: now,
      listPartition: ${UPPER}_LIST_PARTITION,
      // The id is a tiebreaker: two rows created in the same millisecond would
      // otherwise collide on the sort key.
      listSortKey: \`\${now}#\${input.id}\`,
    };

    await this.${pluralCamel}.put(row, { conditionExpression: "attribute_not_exists(id)" });
    return row;
  }

  async update(id: string, changes: { name?: string }): Promise<${pascal}Row | null> {
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

    return this.${pluralCamel}.updateIf({
      key: { id },
      updateExpression: \`SET \${sets.join(", ")}\`,
      conditionExpression: "attribute_exists(id) AND attribute_not_exists(deletedAt)",
      expressionAttributeNames: names,
      expressionAttributeValues: values,
    });
  }

  /**
   * Soft delete. REMOVEing the index attributes drops the row out of every list
   * query for free -- that is what a sparse index buys, versus paying to read
   * deleted rows and filter them out afterwards.
   */
  async softDelete(id: string): Promise<${pascal}Row | null> {
    return this.${pluralCamel}.updateIf({
      key: { id },
      updateExpression: "SET deletedAt = :now, updatedAt = :now REMOVE listPartition, listSortKey",
      conditionExpression: "attribute_exists(id) AND attribute_not_exists(deletedAt)",
      expressionAttributeValues: { ":now": new Date().toISOString() },
      returnValues: "ALL_OLD",
    });
  }

  async list(filter: PaginationQuery): Promise<Page<${pascal}Row>> {
    return this.${pluralCamel}.queryPage({
      indexName: "by-created-at",
      keyConditionExpression: "listPartition = :partition",
      expressionAttributeValues: { ":partition": ${UPPER}_LIST_PARTITION },
      // false = descending: the sort key starts with an ISO-8601 timestamp.
      scanIndexForward: false,
      limit: filter.limit,
      cursor: filter.cursor,
    });
  }
}

export const ${camel}Repository = new ${pascal}Repository();
`,
);

write(
  `backend/src/${rawName}/${rawName}-response.ts`,
  `import type { ${pascal}Row } from "@app/database";

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
export function to${pascal}Response(${camel}: ${pascal}Row): ${pascal}Response {
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
import { ${camel}Repository } from "../../${rawName}/${rawName}-repository.ts";
import { to${pascal}Response } from "../../${rawName}/${rawName}-response.ts";
import { ${pascal}NotFound } from "./errors.ts";

export const ${camel}Routes = routes(
  route("/${plural}", "GET", {
    query: paginationQueryShape,
    handler: async ({ query, c }) => {
      const page = await ${camel}Repository.list(query);

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
      const found = await ${camel}Repository.findById(params.id);
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
      const created = await ${camel}Repository.create({ id: crypto.randomUUID(), ...body });
      return c.json(to${pascal}Response(created), 201);
    },
  }),

  route("/${plural}/:id", "PATCH", {
    body: update${pascal}Schema,
    handler: async ({ params, body, c }) => {
      const updated = await ${camel}Repository.update(params.id, body);
      if (!updated) throw ${pascal}NotFound();
      return c.json(to${pascal}Response(updated), 200);
    },
  }),

  route("/${plural}/:id", "DELETE", {
    handler: async ({ params, c }) => {
      const deleted = await ${camel}Repository.softDelete(params.id);
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
  bun run db:provision      # create the new table\n  bun run dev               # GET/POST /${plural}

No migration step: DynamoDB has no schema, and \`db:provision\` creates the new
table from the definition just written into packages/database/src/tables.ts.
Adding an ACCESS PATTERN is the change that costs -- a new index there.
`);
