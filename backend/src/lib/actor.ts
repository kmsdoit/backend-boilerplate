import { z } from "zod";

/**
 * Who the request is from, parsed out of the JWT.
 *
 * `role` is validated only as a non-empty string, not as an enum of the roles
 * this service knows about, and that is deliberate. The role vocabulary
 * belongs to whatever issues the tokens, and it will grow without this
 * codebase being redeployed.
 *
 * It also gets the 401/403 split right. If `role` were an enum here, a
 * perfectly valid, correctly signed, unexpired token carrying a role this
 * service has not heard of would fail to parse and surface as 401 "invalid or
 * expired token" -- which is a lie, and sends whoever is debugging it after
 * the wrong problem. Parsing succeeds; `requireRole` below then answers the
 * separate question of whether that role is granted anything here, and
 * returns 403 when it is not.
 */
export const actorSchema = z.object({
  sub: z.string().min(1),
  role: z.string().min(1),
});
export type Actor = z.infer<typeof actorSchema>;

/** The roles *this service* grants access to. Extend as the API grows. */
export const actorRoleValues = ["admin", "member"] as const;
export type ActorRole = (typeof actorRoleValues)[number];
