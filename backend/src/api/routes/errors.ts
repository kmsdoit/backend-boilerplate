import { HTTPException } from "hono/http-exception";

/**
 * Domain errors as factories, in one file per API.
 *
 * Two rules keep this useful:
 *
 * 1. Routes throw these; they never construct `new HTTPException(...)` inline.
 *    That way the status and wording for "user not found" are decided once,
 *    and a reader can see the API's entire error vocabulary in one screen.
 * 2. The status code is a decision worth a comment when it is not obvious.
 */

export const UserNotFound = () => new HTTPException(404, { message: "user not found" });

export const UserEmailTaken = () => new HTTPException(409, { message: "email already in use" });

/**
 * 403, not 409 or 400. The request is well-formed and the caller is
 * authenticated -- this is server-side policy refusing to authorise the
 * action, which is exactly what RFC 9110 defines 403 for. 409 is reserved
 * here for "another operation on this resource is in the way", i.e. something
 * a plain retry could resolve.
 */
export const CannotModifySelf = () =>
  new HTTPException(403, { message: "cannot modify your own account through this endpoint" });

/**
 * Maps a Postgres unique-constraint name to the error it should surface as.
 *
 * WHY: a pre-check like "is this email taken?" followed by an insert is not
 * atomic. Two concurrent requests both see "no" and both insert; the unique
 * index rejects the loser. error-handler.ts looks the constraint name up here
 * and produces the same response the pre-check would have, so the caller
 * cannot tell the difference between arriving second and losing a race.
 *
 * Keep constraint names in this map ONLY. A duplicated string elsewhere means
 * a future migration rename silently stops being handled, and the 409 quietly
 * becomes a 500.
 */
export const uniqueConstraintErrors: Record<string, () => HTTPException> = {
  users_active_email_unique: UserEmailTaken,
};
