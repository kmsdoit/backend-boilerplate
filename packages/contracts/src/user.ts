import { z } from "zod";

/**
 * The example domain. Replace it -- it exists to show the shape every domain
 * in this codebase follows:
 *
 *   contracts (this file)  what a request may contain, and the allowed values
 *   database/keys.ts       how it is addressed in the table
 *   backend/<domain>/      repository (all access) + response mapper (what leaves)
 *   backend/api/routes/    the HTTP surface, built from the two above
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
 * `.strictObject` rejects unknown keys instead of ignoring them: on a PATCH
 * that is the difference between a typo'd field being silently dropped (200,
 * nothing changed) and a 400 that names the problem.
 *
 * An absent key means "this PATCH did not touch this field", never "clear it".
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

/**
 * Filters for GET /users.
 *
 * `status` is applied as a DynamoDB FilterExpression: the index is read first
 * and non-matching items are discarded after, so a page can come back shorter
 * than `limit` while still having a `nextCursor`. That is normal and the
 * client must page until the cursor is absent, not until a page looks short.
 *
 * There is deliberately NO free-text search parameter. DynamoDB cannot serve
 * one without a full table Scan, and shipping a Scan behind a friendly query
 * string teaches the wrong thing -- see "Searching" in README.md for what to
 * do instead.
 */
export const listUsersQueryShape = {
  status: z.enum(userStatusValues).optional(),
};
