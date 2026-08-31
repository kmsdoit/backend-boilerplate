/**
 * Entry point. Exports the Hono app so the server script and the test harness
 * both build on the exact same object -- a test that constructs its own app
 * proves nothing about the one that ships.
 */
export { default as app } from "./api/hono.ts";
