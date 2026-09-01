#!/usr/bin/env bun
/**
 * Reverses `new:domain`, and is how you delete the bundled example:
 *
 *   bun run remove:domain user     # start from a clean API
 *   bun run remove:domain post     # undo a scaffold you did not want
 *
 * A boilerplate you cannot cleanly strip is a boilerplate you end up fighting.
 * The example domain touches five layers plus three wiring files, so removing
 * it by hand means finding all of them and leaving the build green.
 *
 * Deliberately does NOT touch migrations. A migration may already be applied
 * here or in someone else's database, so dropping the table is a decision only
 * you can make -- the script tells you which files it left behind.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const rawName = process.argv[2];
if (!rawName || !/^[a-z][a-z0-9-]*$/.test(rawName)) {
  console.error("usage: bun run remove:domain <name>");
  process.exit(1);
}

const pascal = rawName.replace(/(^|-)([a-z])/g, (_, __, c: string) => c.toUpperCase());
const camel = pascal.charAt(0).toLowerCase() + pascal.slice(1);
const plural = `${rawName}s`;
const upper = rawName.replace(/-/g, "_").toUpperCase();
const pluralCamel = `${camel}s`;

const files = [
  `packages/contracts/src/${rawName}.ts`,
  `packages/contracts/src/${rawName}.test.ts`,
  `packages/database/src/${rawName}.integration.test.ts`,
  // Includes the domain's own integration tests, which live beside its code.
  `backend/src/${rawName}`,
  `backend/src/api/routes/${rawName}.ts`,
  `backend/tests/http/${plural}.http`,
];

for (const relativePath of files) {
  const target = resolve(root, relativePath);
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
    console.log(`  removed  ${relativePath}`);
  }
}

/**
 * Drops any line mentioning the domain's symbols.
 *
 * Each rule carries its own replacement because not every edit is a deletion:
 * removing `User` from `export { BaseEntity, User, entities }` has to keep the
 * other two names. An earlier version replaced every match with "" and left
 * a file starting with ` from "./entities/index.ts";`.
 */
function unwire(relativePath: string, rules: [RegExp, string?][]): void {
  const target = resolve(root, relativePath);
  if (!existsSync(target)) {
    return;
  }
  const before = readFileSync(target, "utf8");
  let after = before;
  for (const [pattern, replacement] of rules) {
    after = after.replace(pattern, replacement ?? "");
  }
  after = after.replace(/\n{3,}/g, "\n\n");
  if (after !== before) {
    writeFileSync(target, after);
    console.log(`  unwired  ${relativePath}`);
  }
}

// Multi-line export block in contracts/index.ts, then the single-line wirings.
unwire("packages/contracts/src/index.ts", [
  [new RegExp(`export \\{[^}]*\\} from "\\./${rawName}\\.ts";\\n`, "g")],
]);
// The row type, the table definition and the handle all live in tables.ts.
//
// The patterns match `<Pascal>*Row` / `<camel>*TableDefinition` rather than
// exact names, because a domain may own more than one table -- the bundled
// example has `UserRow` and `UserEmailRow` -- and leaving the second one
// behind provisions a table nothing reads.
unwire("packages/database/src/tables.ts", [
  [
    new RegExp(
      `\\n?/\\*\\*[^*]*\\*/\\n?export type ${pascal}\\w*Row = \\{[\\s\\S]*?\\n\\};\\n`,
      "g",
    ),
  ],
  [new RegExp(`\\n?export type ${pascal}\\w*Row = \\{[\\s\\S]*?\\n\\};\\n`, "g")],
  [new RegExp(`\\n?/\\*\\* The one partition[^\\n]*\\n`, "g")],
  [new RegExp(`export const ${upper}\\w*_LIST_PARTITION = [^\\n]*\\n`, "g")],
  [
    new RegExp(
      `\\n?const ${camel}\\w*TableDefinition: TableDefinition = \\{[\\s\\S]*?\\n\\};\\n`,
      "g",
    ),
  ],
  [new RegExp(`^\\s*\\w+: new DdbTable<${pascal}\\w*Row,[^\\n]*\\n`, "gm")],
]);
unwire("backend/src/api/routes/index.ts", [
  [new RegExp(`.*from "\\./${rawName}\\.ts";\\n`, "g")],
  [new RegExp(`^\\s*\\.\\.\\.${camel}Routes\\.routes,\\n`, "gm")],
]);
unwire("backend/src/api/routes/errors.ts", [
  // The factory declarations, with or without a leading doc comment.
  [
    new RegExp(
      `(/\\*\\*[\\s\\S]*?\\*/\\n)?export const ${pascal}[A-Za-z]* = \\([^)]*\\)[\\s\\S]*?\\}\\);\\n`,
      "g",
    ),
  ],
  [
    new RegExp(
      `(/\\*\\*[\\s\\S]*?\\*/\\n)?export const ${pascal}[A-Za-z]* = \\([^)]*\\) =>\\n[^;]*;\\n`,
      "g",
    ),
  ],
  // ...and any entry in uniqueConstraintErrors that pointed at one of them,
  // which would otherwise be a dangling reference.
  [new RegExp(`^\\s*\\w+: ${pascal}[A-Za-z]*,\\n`, "gm")],
]);

/**
 * The seed script is the one file that cannot just have lines deleted -- it is
 * a program, not a list of wirings. If it seeded this domain, reset it to a
 * skeleton that still runs, so `bun run verify` is green immediately after a
 * removal instead of failing on a dangling import.
 */
const seedPath = resolve(root, "packages/database/src/seed.ts");
if (
  existsSync(seedPath) &&
  new RegExp(`${camel}Key|${pascal}`, "i").test(readFileSync(seedPath, "utf8"))
) {
  writeFileSync(
    seedPath,
    `#!/usr/bin/env bun
/**
 * Idempotent development seed: \`bun run db:seed\`.
 *
 * Idempotent matters -- a seed you can only run against empty tables is a seed
 * nobody runs. Fixed ids mean re-running overwrites the same rows instead of
 * accumulating duplicates.
 */
import { applicationConfig } from "@app/config";

import { provisionTables } from "./provisioning.ts";

if (applicationConfig.application.environment === "production") {
  throw new Error("Refusing to seed production tables.");
}

await provisionTables();

// Seed your domains here, e.g.:
//   await tables.orders.put({ id: "demo", name: "Demo", ... });

console.log(\`\${applicationConfig.application.name} ready\`);
`,
  );
  console.log("  reset    packages/database/src/seed.ts (it seeded this domain)");
}

console.log(`
Left alone on purpose:
  - packages/database/migrations/ -- nothing was deleted. A migration may
    already be applied here or in someone else's database, so dropping the
    table is a decision only you can make: write a new migration for it.

Then: bun run verify
`);
