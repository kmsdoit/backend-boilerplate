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

/** Inserts `line` immediately above the anchor comment, keeping the anchor last. */
function wire(relativePath: string, anchor: string, line: string): void {
  const target = resolve(root, relativePath);
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

/** Filters for GET /${plural}, merged with paginationQueryShape at the route. */
export const list${pascal}sQueryShape = {
  q: z.string().min(1).max(255).optional(),
};
`,
);

write(
  `packages/database/src/entities/${rawName}.ts`,
  `import { Entity, Index, Property } from "@mikro-orm/core";

import { BaseEntity } from "./base.entity.ts";

/**
 * Serves the default list query (\`where deleted_at is null order by
 * created_at desc, id desc\`).
 *
 * MySQL has no partial indexes, so unlike a Postgres schema this cannot be
 * narrowed to live rows -- it covers soft-deleted ones too, which costs a
 * little space and nothing in correctness.
 */
@Entity({ tableName: "${table}" })
@Index({ name: "${table}_created_at_index", properties: ["createdAt", "id"] })
export class ${pascal} extends BaseEntity {
  @Property({ type: "string", length: 255 })
  name!: string;

  /**
   * Null means live. \`datetime(3)\`, not \`timestamp\`: MySQL's default
   * precision is whole seconds, and every connection is pinned to UTC by
   * createMikroOrmConfig -- see base.entity.ts for why that matters.
   *
   * The repository is the only place that knows this filter.
   */
  @Property({ type: "datetime", length: 3, nullable: true })
  deletedAt?: Date;
}
`,
);

write(
  `backend/src/${rawName}/${rawName}-repository.ts`,
  `import { ${pascal}, type EntityManager, type FilterQuery } from "@app/database";
import { toOffset, type Paginated } from "@app/contracts";

export type Create${pascal}Input = {
  name: string;
};

export type Update${pascal}Changes = {
  name?: string;
};

export type List${pascal}sFilter = {
  page: number;
  pageSize: number;
  q?: string;
};

/**
 * A factory taking an EntityManager, not a class holding a global connection.
 *
 * Every read AND every write for this entity lives here. Reads matter for the
 * soft-delete filter (\`deletedAt: null\`) -- a route cannot forget a filter it
 * never writes. Writes matter for the same reason in reverse: \`em.create\` /
 * \`em.flush\` in a route means the rules about which fields may change, and
 * what "deleted" means, get re-decided at each call site.
 */
export function create${pascal}Repository(em: EntityManager) {
  return {
    async findById(id: number): Promise<${pascal} | null> {
      return em.findOne(${pascal}, { id, deletedAt: null });
    },

    async create(input: Create${pascal}Input): Promise<${pascal}> {
      const created = em.create(${pascal}, input);
      em.persist(created);
      await em.flush();
      return created;
    },

    /**
     * Returns null when there is no live row with that id, which is the same
     * thing a caller needs to know as "not found".
     *
     * An absent key means "this PATCH did not touch this field", never "clear
     * it" -- so each field is assigned only when present.
     */
    async update(id: number, changes: Update${pascal}Changes): Promise<${pascal} | null> {
      const found = await em.findOne(${pascal}, { id, deletedAt: null });
      if (!found) {
        return null;
      }

      if (changes.name !== undefined) {
        found.name = changes.name;
      }

      await em.flush();
      return found;
    },

    /** Soft delete: the row stays and anything referencing it stays valid. */
    async softDelete(id: number): Promise<${pascal} | null> {
      const found = await em.findOne(${pascal}, { id, deletedAt: null });
      if (!found) {
        return null;
      }

      found.deletedAt = new Date();
      await em.flush();
      return found;
    },

    async list(filter: List${pascal}sFilter): Promise<Paginated<${pascal}>> {
      const where: FilterQuery<${pascal}> = { deletedAt: null };

      if (filter.q) {
        // \`$like\`, not \`$ilike\`: MySQL has no ILIKE operator. Case-insensitivity
        // comes from the collation (utf8mb4_0900_ai_ci), so it is a property of
        // the schema rather than the query. NOTE a leading-wildcard LIKE cannot
        // use a btree index -- fine for small tables, check the plan before
        // relying on it for a large one.
        where.name = { $like: \`%\${filter.q}%\` };
      }

      // findAndCount issues rows and COUNT together; two separate awaits is how
      // a list ends up reporting a total that disagrees with the page returned.
      const [items, total] = await em.findAndCount(${pascal}, where, {
        limit: filter.pageSize,
        offset: toOffset(filter),
        orderBy: { createdAt: "desc", id: "desc" },
      });

      return { items, total, page: filter.page, pageSize: filter.pageSize };
    },
  };
}

export type ${pascal}Repository = ReturnType<typeof create${pascal}Repository>;
`,
);

write(
  `backend/src/${rawName}/${rawName}-response.ts`,
  `import type { ${pascal} } from "@app/database";

export type ${pascal}Response = {
  id: number;
  name: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * The one place a ${pascal} becomes a response body. Routes must never return
 * the entity: with a mapper, adding a column is inert until someone lists it
 * here; without one, the next migration publishes it to every API client.
 */
export function to${pascal}Response(${camel}: ${pascal}): ${pascal}Response {
  return {
    id: ${camel}.id,
    name: ${camel}.name,
    createdAt: ${camel}.createdAt.toISOString(),
    updatedAt: ${camel}.updatedAt.toISOString(),
  };
}
`,
);

write(
  `backend/src/api/routes/${rawName}.ts`,
  `import { create${pascal}Schema, paginationQueryShape, update${pascal}Schema } from "@app/contracts";

import { route, routes } from "../../lib/app-context.ts";
import { getEntityManager } from "../../lib/db.ts";
import { create${pascal}Repository } from "../../${rawName}/${rawName}-repository.ts";
import { to${pascal}Response } from "../../${rawName}/${rawName}-response.ts";
import { ${pascal}NotFound } from "./errors.ts";

/**
 * Nothing here touches the EntityManager beyond handing it to the repository.
 * A handler's job is authorization against the caller, turning a null result
 * into the right status code, and mapping the entity to a response -- not
 * deciding which fields may change or what "deleted" means.
 */
export const ${camel}Routes = routes(
  route("/${plural}", "GET", {
    query: { ...paginationQueryShape },
    handler: async ({ query, c }) => {
      const em = await getEntityManager();
      const result = await create${pascal}Repository(em).list(query);

      return c.json(
        {
          items: result.items.map(to${pascal}Response),
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
        },
        200,
      );
    },
  }),

  route("/${plural}/:id", "GET", {
    handler: async ({ params, c }) => {
      const em = await getEntityManager();
      const found = await create${pascal}Repository(em).findById(Number(params.id));

      if (!found) {
        throw ${pascal}NotFound();
      }

      return c.json(to${pascal}Response(found), 200);
    },
  }),

  route("/${plural}", "POST", {
    body: create${pascal}Schema,
    handler: async ({ body, c }) => {
      const em = await getEntityManager();
      const created = await create${pascal}Repository(em).create(body);

      return c.json(to${pascal}Response(created), 201);
    },
  }),

  route("/${plural}/:id", "PATCH", {
    body: update${pascal}Schema,
    handler: async ({ params, body, c }) => {
      const em = await getEntityManager();
      const updated = await create${pascal}Repository(em).update(Number(params.id), body);

      if (!updated) {
        throw ${pascal}NotFound();
      }

      return c.json(to${pascal}Response(updated), 200);
    },
  }),

  route("/${plural}/:id", "DELETE", {
    handler: async ({ params, c }) => {
      const em = await getEntityManager();
      const deleted = await create${pascal}Repository(em).softDelete(Number(params.id));

      if (!deleted) {
        throw ${pascal}NotFound();
      }

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
  list${pascal}sQueryShape,
  update${pascal}Schema,
  type Create${pascal}Input,
  type Update${pascal}Input,
} from "./${rawName}.ts";`,
);
wire(
  "packages/database/src/entities/index.ts",
  "domain-imports",
  `import { ${pascal} } from "./${rawName}.ts";`,
);
wire("packages/database/src/entities/index.ts", "domain-entities", `  ${pascal},`);
wire(
  "packages/database/src/entities/index.ts",
  "domain-exports",
  `export { ${pascal} } from "./${rawName}.ts";`,
);
wire(
  "packages/database/src/index.ts",
  "domain-entity-exports",
  `export { ${pascal} } from "./entities/${rawName}.ts";`,
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
  bun run db:generate       # review the migration before committing it
  bun run db:migrate
  bun run dev               # GET/POST /${plural}
`);
