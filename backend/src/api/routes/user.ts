import {
  createUserSchema,
  listUsersQueryShape,
  paginationQueryShape,
  updateUserSchema,
} from "@app/contracts";
import { User } from "@app/database";

import { route, routes } from "../../lib/app-context.ts";
import { getEntityManager } from "../../lib/db.ts";
import { createUserRepository } from "../../user/user-repository.ts";
import { toUserResponse } from "../../user/user-response.ts";
import { CannotModifySelf, UserEmailTaken, UserNotFound } from "./errors.ts";

/**
 * The example API. Copy the shape, replace the domain.
 *
 * Each route declares its query/body schema, so validation happens once, in
 * the adapter, before the handler runs -- a handler never re-checks its own
 * input, and `query` / `body` arrive fully typed from the schema with no cast.
 */
export const userRoutes = routes(
  route("/users", "GET", {
    query: { ...paginationQueryShape, ...listUsersQueryShape },
    handler: async ({ query, c }) => {
      const em = await getEntityManager();
      const users = createUserRepository(em);
      const result = await users.list(query);

      return c.json(
        {
          items: result.items.map(toUserResponse),
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
        },
        200,
      );
    },
  }),

  route("/users/:id", "GET", {
    handler: async ({ params, c }) => {
      const em = await getEntityManager();
      const user = await createUserRepository(em).findById(Number(params.id));

      if (!user) {
        throw UserNotFound();
      }

      return c.json(toUserResponse(user), 200);
    },
  }),

  route("/users", "POST", {
    body: createUserSchema,
    handler: async ({ body, c }) => {
      const em = await getEntityManager();
      const users = createUserRepository(em);

      // A friendly 409 for the common case. This check is NOT the guarantee --
      // it races, and two concurrent requests can both pass it. The partial
      // unique index is the guarantee, and error-handler.ts maps its violation
      // back to this same 409 (see uniqueConstraintErrors in errors.ts).
      if (await users.findByEmail(body.email)) {
        throw UserEmailTaken();
      }

      const user = em.create(User, { ...body, status: "active" });
      em.persist(user);
      await em.flush();

      return c.json(toUserResponse(user), 201);
    },
  }),

  route("/users/:id", "PATCH", {
    body: updateUserSchema,
    handler: async ({ params, body, c }) => {
      const em = await getEntityManager();
      const user = await createUserRepository(em).findById(Number(params.id));

      if (!user) {
        throw UserNotFound();
      }

      // An admin suspending their own account locks everyone out of the thing
      // only they can undo. Cheap guard, expensive incident.
      if (c.get("actor").sub === String(user.id) && body.status === "suspended") {
        throw CannotModifySelf();
      }

      // An absent key means "this PATCH did not touch that field", never
      // "clear it". Assigning `body.name` unconditionally would write
      // undefined over a real name on a request that only changed the role.
      if (body.name !== undefined) {
        user.name = body.name;
      }
      if (body.role !== undefined) {
        user.role = body.role;
      }
      if (body.status !== undefined) {
        user.status = body.status;
      }

      await em.flush();

      return c.json(toUserResponse(user), 200);
    },
  }),

  route("/users/:id", "DELETE", {
    handler: async ({ params, c }) => {
      const em = await getEntityManager();
      const user = await createUserRepository(em).findById(Number(params.id));

      if (!user) {
        throw UserNotFound();
      }

      if (c.get("actor").sub === String(user.id)) {
        throw CannotModifySelf();
      }

      // Soft delete: the row stays, foreign keys stay valid, and the partial
      // unique index frees the email address for reuse.
      user.deletedAt = new Date();
      await em.flush();

      return c.body(null, 204);
    },
  }),
);
