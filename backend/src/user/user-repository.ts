import { User, type EntityManager, type FilterQuery } from "@app/database";
import { toOffset, type Paginated, type UserRole, type UserStatus } from "@app/contracts";

export type CreateUserInput = {
  email: string;
  name: string;
  role: UserRole;
};

export type UpdateUserChanges = {
  name?: string;
  role?: UserRole;
  status?: UserStatus;
};

export type ListUsersFilter = {
  page: number;
  pageSize: number;
  role?: UserRole;
  status?: UserStatus;
  q?: string;
};

/**
 * A factory taking an EntityManager, not a class holding a global connection.
 *
 * Every read AND every write for this entity lives here. Reads matter for the
 * soft-delete filter (`deletedAt: null`) -- a route cannot forget a filter it
 * never writes. Writes matter for the same reason in reverse: `em.create` /
 * `em.flush` in a route means the rules about which fields may change, and
 * what "deleted" means, get re-decided at each call site.
 *
 * What stays in the route is what is genuinely HTTP: authorization against the
 * caller, and turning a null result into the right status code.
 */
export function createUserRepository(em: EntityManager) {
  return {
    async findById(id: number): Promise<User | null> {
      return em.findOne(User, { id, deletedAt: null });
    },

    async findByEmail(email: string): Promise<User | null> {
      return em.findOne(User, { email, deletedAt: null });
    },

    /**
     * Returns null when the address is already taken by a live user.
     *
     * Null rather than an exception because losing that check is an ordinary
     * outcome the caller has to render, not an error. And it is only the
     * friendly path: the check races, so two concurrent requests can both pass
     * it. `users_active_email_unique` is the real guarantee, and
     * error-handler.ts maps its violation to the same 409 -- a caller cannot
     * tell whether they arrived second or lost the race.
     */
    async create(input: CreateUserInput): Promise<User | null> {
      if (await em.findOne(User, { email: input.email, deletedAt: null })) {
        return null;
      }

      const user = em.create(User, { ...input, status: "active" });
      em.persist(user);
      await em.flush();

      return user;
    },

    /**
     * Applies a partial change. Returns null when there is no live user with
     * that id, which is the same thing a caller needs to know as "not found".
     *
     * An absent key means "this PATCH did not touch this field", never "clear
     * it" -- so each field is assigned only when present. Assigning them
     * unconditionally would write undefined over a real value on a request
     * that only meant to change the role.
     */
    async update(id: number, changes: UpdateUserChanges): Promise<User | null> {
      const user = await em.findOne(User, { id, deletedAt: null });
      if (!user) {
        return null;
      }

      if (changes.name !== undefined) {
        user.name = changes.name;
      }
      if (changes.role !== undefined) {
        user.role = changes.role;
      }
      if (changes.status !== undefined) {
        user.status = changes.status;
      }

      await em.flush();
      return user;
    },

    /**
     * Soft delete: the row stays, anything referencing it stays valid, and the
     * `email_active` generated column becomes NULL so the address is free for
     * reuse. Returns null when there is no live user with that id.
     */
    async softDelete(id: number): Promise<User | null> {
      const user = await em.findOne(User, { id, deletedAt: null });
      if (!user) {
        return null;
      }

      user.deletedAt = new Date();
      await em.flush();

      return user;
    },

    async list(filter: ListUsersFilter): Promise<Paginated<User>> {
      // FilterQuery<User>, not Record<string, unknown>: a mistyped field name
      // in a filter is otherwise accepted silently and simply matches nothing,
      // which reads as "no results" rather than as the bug it is.
      const where: FilterQuery<User> = { deletedAt: null };

      if (filter.role) {
        where.role = filter.role;
      }
      if (filter.status) {
        where.status = filter.status;
      }
      if (filter.q) {
        // $like, not $ilike: MySQL has no ILIKE operator (MikroORM passes the
        // keyword straight through and the server rejects it). Case-insensitivity
        // comes from the COLLATION instead -- utf8mb4_0900_ai_ci, the 8.0
        // default and what compose.yaml pins, compares case-insensitively.
        //
        // That means the behaviour is a property of the schema, not the query:
        // move this table to a _bin or _cs collation and search silently
        // becomes case-sensitive with no code change to notice.
        //
        // The wildcards are added here rather than taken from the caller so a
        // client cannot smuggle in a pattern.
        where.$or = [{ name: { $like: `%${filter.q}%` } }, { email: { $like: `%${filter.q}%` } }];
      }

      // findAndCount issues the rows query and the COUNT in one call. Doing it
      // as two separate awaits is the usual way a paginated list ends up
      // reporting a total that does not match the page it returned.
      const [items, total] = await em.findAndCount(User, where, {
        limit: filter.pageSize,
        offset: toOffset(filter),
        orderBy: { createdAt: "desc", id: "desc" },
      });

      return { items, total, page: filter.page, pageSize: filter.pageSize };
    },
  };
}

export type UserRepository = ReturnType<typeof createUserRepository>;
