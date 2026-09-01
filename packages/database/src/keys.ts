/**
 * Key construction, in one place.
 *
 * In DynamoDB the key layout IS the schema: there is no ALTER TABLE to fix a
 * bad choice later, only a migration that rewrites every item. Keeping every
 * key string in this file means the layout can be read in one screen and
 * changed in one place.
 *
 * LAYOUT
 *   users             pk = USER#<id>
 *   email uniqueness  pk = EMAIL#<lowercased email>   (a lock item, see below)
 *   list newest-first GSI gsi1: gsi1pk = USER, gsi1sk = <createdAt>#<id>
 */

export const GSI1 = "gsi1";

/**
 * Sort key for any list index. `createdAt` alone is not unique -- two items
 * created in the same millisecond would collide and one would overwrite the
 * other -- so the id is appended as a tiebreaker. ISO-8601 sorts
 * lexicographically, which is what makes a string sort key work as a time order.
 */
export const listSortKey = (createdAt: string, id: string) => `${createdAt}#${id}`;

// Each domain's keys live in a marked block so `bun run remove:domain` can
// take the whole block out deterministically instead of pattern-matching lines.
// domain:user
/** Constant partition for "every live user, newest first". */
export const USER_LIST_PARTITION = "USER";
export const userKey = (id: string) => `USER#${id}`;
/**
 * Email is lowercased before it becomes a key. DynamoDB compares bytes, so
 * without this "A@x.com" and "a@x.com" are two different users.
 */
export const emailKey = (email: string) => `EMAIL#${email.trim().toLowerCase()}`;
// /domain:user

// domain-keys: `bun run new:domain` inserts above this line.
