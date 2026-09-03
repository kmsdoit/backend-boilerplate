import { User, type EntityManager, type FilterQuery } from "@app/database";
import { toOffset, type Paginated, type UserRole, type UserStatus } from "@app/contracts";

export type ListUsersFilter = {
  page: number;
  pageSize: number;
  role?: UserRole;
  status?: UserStatus;
  q?: string;
};

/**
 * A factory taking an EntityManager, not a class holding a global connection.
 * Every query for this entity lives here, which is what makes the soft-delete
 * filter (`deletedAt: null`) enforceable: a route cannot forget it, because a
 * route never writes a query.
 */
export function createUserRepository(em: EntityManager) {
  return {
    async findById(id: number): Promise<User | null> {
      return em.findOne(User, { id, deletedAt: null });
    },

    async findByEmail(email: string): Promise<User | null> {
      return em.findOne(User, { email, deletedAt: null });
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
