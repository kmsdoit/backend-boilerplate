import { routes } from "../../lib/app-context.ts";
import type { ExtractRoutes } from "../../lib/route.ts";
import { userRoutes } from "./user.ts";
// domain-imports: `bun run new:domain` inserts above this line.

/** Every route in the API. Add a domain by spreading its collection here. */
export const api = routes(
  ...userRoutes.routes,
  // domain-routes: `bun run new:domain` inserts above this line.
);

/**
 * The full API surface as a type: path -> method -> { params, query, body,
 * response }. Import it from a TypeScript client to get end-to-end types
 * without a code generator or a build step.
 */
export type ApiRoutes = ExtractRoutes<typeof api.routes>;
