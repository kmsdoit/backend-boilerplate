import type { UserRole, UserStatus } from "@app/contracts";

import type { UserRecord } from "./user-repository.ts";

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
 * of attributes, so `pk`, `gsi1pk`, `gsi1sk` and `deletedAt` would all be
 * serialised straight to the client by an accidental `c.json(item)`. Listing
 * fields explicitly is what stops key layout from becoming public API.
 */
export function toUserResponse(user: UserRecord): UserResponse {
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
