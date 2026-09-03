import type { User } from "@app/database";
import type { UserRole, UserStatus } from "@app/contracts";

export type UserResponse = {
  id: number;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
};

/**
 * The one place an entity becomes a response body.
 *
 * Routes must never return an entity directly. With a mapper, adding a column
 * -- a password hash, an internal flag, a soft-delete timestamp -- is inert
 * until someone deliberately adds it here. Without one, the next migration
 * silently publishes it to every API client.
 *
 * Dates are serialised as ISO-8601 strings explicitly rather than left to
 * JSON.stringify's default, so the format is a decision recorded in code
 * instead of an accident of the serialiser.
 */
export function toUserResponse(user: User): UserResponse {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
