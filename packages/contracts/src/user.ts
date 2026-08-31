import { z } from "zod";

/**
 * The example domain. Replace it -- it exists to show the shape every domain
 * in this codebase follows:
 *
 *   contracts (this file)  what a request may contain, and the allowed values
 *   database/entities      how it is stored
 *   backend/<domain>/      repository (queries) + response mapper (what leaves)
 *   backend/api/routes/    the HTTP surface, built from the two above
 *
 * The split matters most at the last step: a route never returns an entity
 * directly, so adding a column (a password hash, an internal flag) cannot
 * accidentally start appearing in API responses.
 */

export const userRoleValues = ["admin", "member"] as const;
export type UserRole = (typeof userRoleValues)[number];

export const userStatusValues = ["active", "suspended"] as const;
export type UserStatus = (typeof userStatusValues)[number];

export const createUserSchema = z.strictObject({
  email: z.email(),
  name: z.string().min(1).max(255),
  role: z.enum(userRoleValues).default("member"),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

/**
 * `.strictObject` rejects unknown keys instead of ignoring them. On a PATCH
 * that is the difference between a typo'd field name being silently dropped
 * (the request returns 200 and nothing changed) and the caller getting a 400
 * that names the problem.
 *
 * Every field is optional, and an absent key means "this PATCH did not touch
 * this field" -- never "clear it". `.refine` rejects the empty body, since a
 * PATCH that changes nothing is a mistake somewhere upstream.
 */
export const updateUserSchema = z
  .strictObject({
    name: z.string().min(1).max(255).optional(),
    role: z.enum(userRoleValues).optional(),
    status: z.enum(userStatusValues).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one field must be provided",
  });
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

/** Filters for GET /users, merged with paginationQueryShape at the route. */
export const listUsersQueryShape = {
  role: z.enum(userRoleValues).optional(),
  status: z.enum(userStatusValues).optional(),
  /** Case-insensitive partial match on name or email. */
  q: z.string().min(1).max(255).optional(),
};
