import type { UserRole, UserStatus } from "@app/contracts";

import type { UserRow } from "@app/database";

export type UserResponse = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
};

/**
 * The one place a user becomes a response body.
 *
 * It matters more here than with a relational mapper: a DynamoDB item is a bag
 * of attributes, so `listPartition`, `listSortKey` and `deletedAt` would all be
 * serialised straight to the client by an accidental `c.json(item)`. Listing
 * fields explicitly is what stops key layout from becoming public API.
 */
export function toUserResponse(user: UserRow): UserResponse {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
