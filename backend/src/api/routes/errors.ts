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
 * Uniqueness is enforced by a conditional write on a lock item, not by a
 * constraint the database owns, so there is no driver error code to translate
 * at the edge the way `23505` was. The repository raises
 * `UniqueConstraintError` and the route maps it here -- see
 * `createUserRepository.create` for the write sequence and what it costs.
 */
