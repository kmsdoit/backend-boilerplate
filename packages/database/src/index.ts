export { doc, rawClient, tableNameFor } from "./client.ts";
export { decodeCursor, encodeCursor } from "./cursor.ts";
export { DdbTable, type DdbKey, type Page, type TableDefinition } from "./table.ts";
export { provisionTables, tablesReady } from "./provisioning.ts";
/**
 * `export *` on purpose: tables.ts holds every row type, list partition and
 * table handle, and a new domain adds all three at once. Listing them here by
 * hand would mean a fourth place to remember, and a domain that compiles
 * everywhere except at its own import.
 */
export * from "./tables.ts";
